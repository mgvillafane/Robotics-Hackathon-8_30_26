import {
  Box3,
  Matrix4,
  Mesh,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { URDFRobot } from 'urdf-loader';
import type { CollisionPair } from '../state/diagnostics';

/**
 * drei bundles its own older three-mesh-bvh, and both copies declare
 * `BufferGeometry.boundsTree`, so the ambient type resolves to an impossible
 * intersection of two different MeshBVH classes. Only this module writes the
 * field, and it always writes an instance of the version imported here.
 */
type BvhCache = { boundsTree?: MeshBVH };

function bvhCache(geometry: BufferGeometry): BvhCache {
  return geometry as unknown as BvhCache;
}

interface LinkMesh {
  mesh: Mesh;
  bvh: MeshBVH;
  /** Geometry-space bounds, transformed per frame for the broad phase. */
  localBounds: Box3;
  originalMaterial: Material | Material[];
}

interface CollisionLink {
  name: string;
  node: Object3D;
  meshes: LinkMesh[];
  worldBounds: Box3;
}

export interface CollisionModel {
  links: CollisionLink[];
  /** Index pairs worth testing, after adjacency and rest-pose filtering. */
  pairs: Array<[number, number]>;
  /** Pairs skipped because their meshes overlap in every sampled pose. */
  ignoredAlways: CollisionPair[];
  /** Links tested against the mounting surface, i.e. everything not resting on it. */
  groundLinks: number[];
  buildMs: number;
  triangleCount: number;
  dispose(): void;
}

/** Stands in for the mounting surface in reported contacts. */
export const GROUND = 'mounting surface';

/**
 * How far a link may dip below the surface before it counts as a contact. The
 * base sits exactly on y = 0, so a plane at exactly zero would fire constantly.
 */
const GROUND_TOLERANCE = 0.002;

/**
 * Everything below the mounting surface, in world space. Kept to the size of a
 * plausible workspace rather than something enormous, to avoid precision loss
 * when it is transformed into each mesh's local frame.
 */
const groundVolume = new Box3(new Vector3(-2, -2, -2), new Vector3(2, -GROUND_TOLERANCE, 2));

// Scratch objects: collision runs every frame and must not allocate.
const boxA = new Box3();
const boxB = new Box3();
const relative = new Matrix4();
const inverse = new Matrix4();

function isLink(node: Object3D): boolean {
  return (node as { isURDFLink?: boolean }).isURDFLink === true;
}

function isJoint(node: Object3D): boolean {
  return (node as { isURDFJoint?: boolean }).isURDFJoint === true;
}

/**
 * Meshes belonging to one link. Child links hang off joint nodes, so descending
 * into either would attribute a child's geometry to its parent.
 */
function collectLinkMeshes(linkNode: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  const walk = (node: Object3D) => {
    for (const child of node.children) {
      if (isLink(child) || isJoint(child)) continue;
      if ((child as Mesh).isMesh) meshes.push(child as Mesh);
      walk(child);
    }
  };
  walk(linkNode);
  return meshes;
}

function nearestLinkAncestor(node: Object3D): Object3D | null {
  let current = node.parent;
  while (current) {
    if (isLink(current)) return current;
    current = current.parent;
  }
  return null;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function meshesIntersect(a: LinkMesh, b: LinkMesh): boolean {
  boxA.copy(a.localBounds).applyMatrix4(a.mesh.matrixWorld);
  boxB.copy(b.localBounds).applyMatrix4(b.mesh.matrixWorld);
  if (!boxA.intersectsBox(boxB)) return false;

  inverse.copy(a.mesh.matrixWorld).invert();
  relative.multiplyMatrices(inverse, b.mesh.matrixWorld);
  return a.bvh.intersectsGeometry(b.mesh.geometry, relative);
}

function linksIntersect(a: CollisionLink, b: CollisionLink): boolean {
  for (const meshA of a.meshes) {
    for (const meshB of b.meshes) {
      if (meshesIntersect(meshA, meshB)) return true;
    }
  }
  return false;
}

/** True when any of the link's geometry sits below the mounting surface. */
function linkBelowGround(link: CollisionLink): boolean {
  if (link.worldBounds.min.y >= -GROUND_TOLERANCE) return false;
  for (const { mesh, bvh } of link.meshes) {
    inverse.copy(mesh.matrixWorld).invert();
    if (bvh.intersectsBox(groundVolume, inverse)) return true;
  }
  return false;
}

function updateWorldBounds(link: CollisionLink): void {
  link.worldBounds.makeEmpty();
  for (const { mesh, localBounds } of link.meshes) {
    boxA.copy(localBounds).applyMatrix4(mesh.matrixWorld);
    link.worldBounds.union(boxA);
  }
}

type Pose = Array<[string, number]>;

/**
 * A handful of poses spanning the joint ranges, used to tell permanent mesh
 * overlap from overlap that merely happens to occur at one configuration.
 */
function samplePoses(robot: URDFRobot): Pose[] {
  const entries = Object.entries(robot.joints);

  const at = (choose: (lower: number, upper: number) => number): Pose =>
    entries.map(([name, joint]) => {
      const lower = Number(joint.limit?.lower ?? 0);
      const upper = Number(joint.limit?.upper ?? 0);
      // Fixed and continuous joints report a degenerate range; leave them put.
      if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) {
        return [name, 0];
      }
      return [name, choose(lower, upper)];
    });

  return [
    at(() => 0),
    at((lower) => lower),
    at((_lower, upper) => upper),
    at((lower, upper) => (lower + upper) / 2),
  ];
}

function applyPose(robot: URDFRobot, pose: Pose): void {
  for (const [name, angle] of pose) robot.joints[name]?.setJointValue(angle);
  robot.updateMatrixWorld(true);
}

/**
 * Prepares a robot for collision queries.
 *
 * Builds a bounding volume hierarchy per mesh, then decides what is worth
 * testing. Directly connected links are excluded, since they touch at their
 * shared joint by construction. Beyond that, a pair is only excluded if its
 * meshes overlap in *every* sampled pose — the signature of a motor horn seated
 * inside its bracket, which would otherwise report a collision forever. Judging
 * that from the zero pose alone would wrongly retire pairs that merely start out
 * folded together, which on a 5-DOF arm tends to be exactly the base-versus-arm
 * pairs worth watching. Same reasoning for the mounting surface: a link counts
 * as mounted on it, rather than crashing into it, only if it sits below the
 * surface no matter how the joints move.
 */
export function buildCollisionModel(robot: URDFRobot): CollisionModel {
  const start = performance.now();

  const links: CollisionLink[] = [];
  let triangleCount = 0;

  for (const [name, node] of Object.entries(robot.links)) {
    const meshes = collectLinkMeshes(node).filter(
      (mesh) => mesh.geometry?.getAttribute('position') !== undefined,
    );
    if (meshes.length === 0) continue;

    links.push({
      name,
      node,
      worldBounds: new Box3(),
      meshes: meshes.map((mesh) => {
        const geometry = mesh.geometry;
        const cache = bvhCache(geometry);
        const bvh = cache.boundsTree ?? new MeshBVH(geometry);
        // Sharing the tree on the geometry lets intersectsGeometry take its
        // two-sided fast path instead of walking raw triangles.
        cache.boundsTree = bvh;

        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const index = geometry.getIndex();
        triangleCount += (index ? index.count : geometry.getAttribute('position').count) / 3;

        return {
          mesh,
          bvh,
          localBounds: geometry.boundingBox!.clone(),
          originalMaterial: mesh.material,
        };
      }),
    });
  }

  const indexByName = new Map(links.map((link, index) => [link.name, index]));

  const adjacent = new Set<string>();
  for (const link of links) {
    const parent = nearestLinkAncestor(link.node);
    const parentName = parent
      ? Object.entries(robot.links).find(([, node]) => node === parent)?.[0]
      : undefined;
    if (parentName && indexByName.has(parentName)) {
      adjacent.add(pairKey(link.name, parentName));
    }
  }

  const candidates: Array<[number, number]> = [];
  for (let i = 0; i < links.length; i += 1) {
    for (let j = i + 1; j < links.length; j += 1) {
      if (adjacent.has(pairKey(links[i].name, links[j].name))) continue;
      candidates.push([i, j]);
    }
  }

  const savedAngles: Pose = Object.entries(robot.joints).map(([name, joint]) => [
    name,
    joint.angle,
  ]);

  const poses = samplePoses(robot);
  const overlapCount = new Uint8Array(candidates.length);
  const belowCount = new Uint8Array(links.length);

  for (const pose of poses) {
    applyPose(robot, pose);

    for (let c = 0; c < candidates.length; c += 1) {
      const [i, j] = candidates[c];
      if (linksIntersect(links[i], links[j])) overlapCount[c] += 1;
    }

    for (let i = 0; i < links.length; i += 1) {
      updateWorldBounds(links[i]);
      if (linkBelowGround(links[i])) belowCount[i] += 1;
    }
  }

  applyPose(robot, savedAngles);

  const pairs: Array<[number, number]> = [];
  const ignoredAlways: CollisionPair[] = [];
  for (let c = 0; c < candidates.length; c += 1) {
    const [i, j] = candidates[c];
    if (overlapCount[c] === poses.length) {
      ignoredAlways.push({ a: links[i].name, b: links[j].name });
    } else {
      pairs.push(candidates[c]);
    }
  }

  const groundLinks: number[] = [];
  for (let i = 0; i < links.length; i += 1) {
    if (belowCount[i] < poses.length) groundLinks.push(i);
  }

  return {
    links,
    pairs,
    ignoredAlways,
    groundLinks,
    triangleCount: Math.round(triangleCount),
    buildMs: performance.now() - start,
    dispose() {
      for (const link of links) {
        for (const linkMesh of link.meshes) {
          linkMesh.mesh.material = linkMesh.originalMaterial;
          delete bvhCache(linkMesh.mesh.geometry).boundsTree;
        }
      }
      links.length = 0;
    },
  };
}

/**
 * Fills `out` with contacts at the robot's current pose: link-against-link, and
 * optionally link-against-mounting-surface. Callers must have updated world
 * matrices first.
 */
export function detectCollisions(
  model: CollisionModel,
  out: CollisionPair[],
  includeGround = true,
): CollisionPair[] {
  out.length = 0;
  for (const link of model.links) updateWorldBounds(link);

  for (const [i, j] of model.pairs) {
    const a = model.links[i];
    const b = model.links[j];
    if (!a.worldBounds.intersectsBox(b.worldBounds)) continue;
    if (linksIntersect(a, b)) out.push({ a: a.name, b: b.name });
  }

  if (includeGround) {
    for (const index of model.groundLinks) {
      const link = model.links[index];
      if (linkBelowGround(link)) out.push({ a: link.name, b: GROUND });
    }
  }

  return out;
}

/** Swaps the given links onto a highlight material and restores the rest. */
export function applyHighlight(
  model: CollisionModel,
  highlighted: ReadonlySet<string>,
  material: Material,
): void {
  for (const link of model.links) {
    const shouldHighlight = highlighted.has(link.name);
    for (const linkMesh of link.meshes) {
      const target = shouldHighlight ? material : linkMesh.originalMaterial;
      if (linkMesh.mesh.material !== target) linkMesh.mesh.material = target;
    }
  }
}
