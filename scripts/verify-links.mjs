/**
 * Headless audit of collision pair selection, without a DOM.
 *
 * urdf-loader needs DOMParser, so this reimplements just enough URDF kinematics
 * to answer one question: after the adjacency and always-overlapping filters,
 * which link pairs and which link-vs-surface tests actually survive? Use it to
 * confirm that the pairs you care about — anything against the base, in
 * particular — are really being watched each frame.
 *
 * Usage: node scripts/verify-links.mjs [robotDir] [urdfFile]
 */
import { readFileSync } from 'node:fs';
import { Box3, Euler, Group, Matrix4, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { MeshBVH } from 'three-mesh-bvh';

const ROOT = process.argv[2] ?? 'public/robots/so101';
const URDF = `${ROOT}/${process.argv[3] ?? 'so101_new_calib.urdf'}`;

const GROUND_TOLERANCE = 0.002;
const groundVolume = new Box3(new Vector3(-2, -2, -2), new Vector3(2, -GROUND_TOLERANCE, 2));

// --- minimal URDF parsing ----------------------------------------------

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : null;
}

function nums(text, fallback) {
  if (!text) return fallback;
  return text.trim().split(/\s+/).map(Number);
}

/** First <origin> in a block. URDF rpy is fixed-axis, i.e. Rz*Ry*Rx. */
function originOf(block) {
  const tag = block.match(/<origin\s[^>]*>/)?.[0] ?? '';
  const xyz = nums(attr(tag, 'xyz'), [0, 0, 0]);
  const rpy = nums(attr(tag, 'rpy'), [0, 0, 0]);
  return {
    position: new Vector3(...xyz),
    quaternion: new Quaternion().setFromEuler(new Euler(rpy[0], rpy[1], rpy[2], 'ZYX')),
  };
}

const text = readFileSync(URDF, 'utf8');
const loader = new STLLoader();

const linkNodes = new Map();
const linkMeshes = new Map();

for (const [, name, body] of text.matchAll(/<link\s+name="([^"]+)"([\s\S]*?)<\/link>/g)) {
  const node = new Object3D();
  node.name = name;
  linkNodes.set(name, node);

  const meshes = [];
  for (const [, visual] of body.matchAll(/<visual[^>]*>([\s\S]*?)<\/visual>/g)) {
    const file = attr(visual.match(/<mesh\s[^>]*>/)?.[0] ?? '', 'filename');
    if (!file) continue;

    const buffer = readFileSync(`${ROOT}/${file}`);
    const geometry = loader.parse(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
    geometry.computeBoundingBox();

    const mesh = new Mesh(geometry);
    const origin = originOf(visual);
    mesh.position.copy(origin.position);
    mesh.quaternion.copy(origin.quaternion);
    node.add(mesh);
    meshes.push({ mesh, bvh: new MeshBVH(geometry), localBounds: geometry.boundingBox.clone() });
  }
  linkMeshes.set(name, meshes);
}

const joints = [];
const childOf = new Set();

// Requiring type= skips the <joint name="..."> references inside <transmission>.
for (const [, name, type, body] of text.matchAll(
  /<joint\s+name="([^"]+)"\s+type="([^"]+)"([\s\S]*?)<\/joint>/g,
)) {
  const parent = attr(body.match(/<parent\s[^>]*>/)?.[0] ?? '', 'link');
  const child = attr(body.match(/<child\s[^>]*>/)?.[0] ?? '', 'link');
  if (!linkNodes.has(parent) || !linkNodes.has(child)) continue;

  const origin = originOf(body);
  const node = new Object3D();
  node.name = name;
  node.position.copy(origin.position);
  node.quaternion.copy(origin.quaternion);

  linkNodes.get(parent).add(node);
  node.add(linkNodes.get(child));
  childOf.add(child);

  const rawAxis = new Vector3(...nums(attr(body.match(/<axis\s[^>]*>/)?.[0] ?? '', 'xyz'), [1, 0, 0]));
  const limitTag = body.match(/<limit\s[^>]*>/)?.[0] ?? '';

  joints.push({
    name,
    type,
    node,
    parent,
    child,
    originQuat: origin.quaternion.clone(),
    axis: rawAxis.lengthSq() > 0 ? rawAxis.normalize() : new Vector3(1, 0, 0),
    lower: Number(attr(limitTag, 'lower') ?? 0),
    upper: Number(attr(limitTag, 'upper') ?? 0),
  });
}

const rootName = [...linkNodes.keys()].find((name) => !childOf.has(name));

// --- scene assembly, mirroring RobotModel ------------------------------

const grounded = new Group();
const rotated = new Group();
rotated.rotation.x = -Math.PI / 2; // Z-up URDF into the Y-up scene
grounded.add(rotated);
rotated.add(linkNodes.get(rootName));

const scratchQuat = new Quaternion();

function setPose(chooser) {
  for (const joint of joints) {
    if (joint.type === 'fixed') continue;
    const usable =
      Number.isFinite(joint.lower) && Number.isFinite(joint.upper) && joint.upper > joint.lower;
    const angle = usable ? chooser(joint.lower, joint.upper) : 0;
    joint.node.quaternion
      .copy(joint.originQuat)
      .multiply(scratchQuat.setFromAxisAngle(joint.axis, angle));
  }
  grounded.updateWorldMatrix(true, true);
}

setPose(() => 0);
const restBox = new Box3().setFromObject(grounded);
grounded.position.y = -restBox.min.y;
grounded.updateWorldMatrix(true, true);

// --- intersection helpers, same conventions as selfCollision.ts --------

const boxA = new Box3();
const boxB = new Box3();
const relative = new Matrix4();
const inverse = new Matrix4();

function meshesIntersect(a, b) {
  boxA.copy(a.localBounds).applyMatrix4(a.mesh.matrixWorld);
  boxB.copy(b.localBounds).applyMatrix4(b.mesh.matrixWorld);
  if (!boxA.intersectsBox(boxB)) return false;

  inverse.copy(a.mesh.matrixWorld).invert();
  relative.multiplyMatrices(inverse, b.mesh.matrixWorld);
  return a.bvh.intersectsGeometry(b.mesh.geometry, relative);
}

function linksIntersect(a, b) {
  for (const meshA of linkMeshes.get(a)) {
    for (const meshB of linkMeshes.get(b)) {
      if (meshesIntersect(meshA, meshB)) return true;
    }
  }
  return false;
}

function worldBounds(name) {
  const box = new Box3();
  for (const { mesh, localBounds } of linkMeshes.get(name)) {
    box.union(boxA.copy(localBounds).applyMatrix4(mesh.matrixWorld));
  }
  return box;
}

function belowGround(name) {
  if (worldBounds(name).min.y >= -GROUND_TOLERANCE) return false;
  for (const { mesh, bvh } of linkMeshes.get(name)) {
    inverse.copy(mesh.matrixWorld).invert();
    if (bvh.intersectsBox(groundVolume, inverse)) return true;
  }
  return false;
}

// --- the audit ---------------------------------------------------------

const names = [...linkMeshes.keys()].filter((name) => linkMeshes.get(name).length > 0);
const adjacent = new Set(
  joints.map(({ parent, child }) => (parent < child ? `${parent}|${child}` : `${child}|${parent}`)),
);

const candidates = [];
for (let i = 0; i < names.length; i += 1) {
  for (let j = i + 1; j < names.length; j += 1) {
    const key = names[i] < names[j] ? `${names[i]}|${names[j]}` : `${names[j]}|${names[i]}`;
    if (!adjacent.has(key)) candidates.push([names[i], names[j]]);
  }
}

const choosers = [
  ['zero', () => 0],
  ['lower', (lower) => lower],
  ['upper', (_lower, upper) => upper],
  ['mid', (lower, upper) => (lower + upper) / 2],
];

const overlaps = new Map(candidates.map((pair) => [pair.join('|'), []]));
const below = new Map(names.map((name) => [name, []]));

for (const [label, chooser] of choosers) {
  setPose(chooser);
  for (const [a, b] of candidates) {
    if (linksIntersect(a, b)) overlaps.get(`${a}|${b}`).push(label);
  }
  for (const name of names) {
    if (belowGround(name)) below.get(name).push(label);
  }
}

setPose(() => 0);

console.log(`robot: ${URDF}`);
console.log(`root link: ${rootName}`);
console.log(`links with geometry: ${names.length}, joints: ${joints.length}`);
console.log(`grounding offset: ${grounded.position.y.toFixed(4)} m\n`);

const tested = candidates.filter(([a, b]) => overlaps.get(`${a}|${b}`).length < choosers.length);
const retired = candidates.filter(([a, b]) => overlaps.get(`${a}|${b}`).length === choosers.length);

console.log(`link pairs tested each frame (${tested.length}):`);
for (const [a, b] of tested) {
  const hits = overlaps.get(`${a}|${b}`);
  const base = a === rootName || b === rootName ? '  <- base' : '';
  const note = hits.length > 0 ? `  (overlaps at: ${hits.join(', ')})` : '';
  console.log(`  ${a} / ${b}${note}${base}`);
}

// The previous filter judged overlap from the zero pose alone, so anything
// overlapping there would have been retired for the whole session.
const zeroOnly = tested.filter(([a, b]) => overlaps.get(`${a}|${b}`).includes('zero'));
if (zeroOnly.length > 0) {
  console.log(
    `\n  note: ${zeroOnly.length} of the above overlap at the zero pose and would be lost\n` +
      '        if pair selection were judged from that single pose.',
  );
}

console.log(`\nretired as always overlapping (${retired.length}):`);
for (const [a, b] of retired) console.log(`  ${a} / ${b}`);

const groundTested = names.filter((name) => below.get(name).length < choosers.length);
console.log(`\nlinks tested against the mounting surface (${groundTested.length}):`);
for (const name of groundTested) {
  const hits = below.get(name);
  console.log(`  ${name}${hits.length > 0 ? `  (dips below at: ${hits.join(', ')})` : ''}`);
}

const alwaysBelow = names.filter((name) => below.get(name).length === choosers.length);
console.log(`\nexcluded as resting on the surface (${alwaysBelow.length}):`);
for (const name of alwaysBelow) console.log(`  ${name}`);

const basePairs = tested.filter(([a, b]) => a === rootName || b === rootName);
const baseRetired = retired.filter(([a, b]) => a === rootName || b === rootName);

console.log('');
if (basePairs.length === 0) {
  console.log(`FAIL no pair involving ${rootName} is being tested.`);
  process.exit(1);
}
console.log(
  `ok  ${basePairs.length} pair(s) against ${rootName} tested` +
    (baseRetired.length > 0 ? `, ${baseRetired.length} retired` : ''),
);
