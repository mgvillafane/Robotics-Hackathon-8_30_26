/**
 * Checks the matrix convention used for BVH mesh-vs-mesh queries.
 *
 * intersectsGeometry expects the other geometry expressed in the BVH owner's
 * local space, i.e. inverse(A.matrixWorld) * B.matrixWorld. Getting this
 * backwards still "works" for symmetric cases at the origin, so it is worth
 * testing with an offset parent and a rotation.
 */
import { Box3, BoxGeometry, Matrix4, Mesh, Group, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const geometryA = new BoxGeometry(1, 1, 1);
const geometryB = new BoxGeometry(1, 1, 1);
const bvhA = new MeshBVH(geometryA);
geometryB.boundsTree = new MeshBVH(geometryB);

const meshA = new Mesh(geometryA);
const meshB = new Mesh(geometryB);

// Put both under a moved+rotated parent so world matrices are non-trivial.
const parent = new Group();
parent.position.set(3, -2, 7);
parent.rotation.set(0.4, 1.1, -0.6);
parent.add(meshA, meshB);

const relative = new Matrix4();
const inverse = new Matrix4();

function intersects() {
  parent.updateMatrixWorld(true);
  inverse.copy(meshA.matrixWorld).invert();
  relative.multiplyMatrices(inverse, meshB.matrixWorld);
  return bvhA.intersectsGeometry(geometryB, relative);
}

const cases = [
  { name: 'overlapping (0.5 apart)', pos: [0.5, 0, 0], rot: 0, expect: true },
  { name: 'just touching (1.0 apart)', pos: [0.999, 0, 0], rot: 0, expect: true },
  { name: 'clear (2.0 apart)', pos: [2, 0, 0], rot: 0, expect: false },
  { name: 'clear diagonally', pos: [1.4, 1.4, 1.4], rot: 0, expect: false },
  { name: 'rotated into contact', pos: [1.2, 0, 0], rot: Math.PI / 4, expect: true },
  { name: 'far away', pos: [50, 0, 0], rot: 0.7, expect: false },
];

let failures = 0;
for (const testCase of cases) {
  meshB.position.set(...testCase.pos);
  meshB.rotation.set(0, 0, testCase.rot);
  const actual = intersects();
  const ok = actual === testCase.expect;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${testCase.name.padEnd(26)} expected ${testCase.expect}, got ${actual}`);
}

// --- mounting surface ---------------------------------------------------
// Same convention, but against a static world-space volume: everything below
// y = -tolerance. boxToBvh maps world into the mesh's local frame.

const TOLERANCE = 0.002;
const groundVolume = new Box3(new Vector3(-2, -2, -2), new Vector3(2, -TOLERANCE, 2));
const ground = new Group();
const groundMesh = new Mesh(geometryA);
ground.add(groundMesh);

function belowGround() {
  ground.updateMatrixWorld(true);
  inverse.copy(groundMesh.matrixWorld).invert();
  return bvhA.intersectsBox(groundVolume, inverse);
}

const groundCases = [
  { name: 'well above surface', pos: 1.0, rot: 0, expect: false },
  { name: 'resting exactly on it', pos: 0.5, rot: 0, expect: false },
  { name: 'sunk halfway', pos: 0.0, rot: 0, expect: true },
  { name: 'barely dipped (3mm)', pos: 0.497, rot: 0, expect: true },
  { name: 'rotated corner dips', pos: 0.5, rot: Math.PI / 4, expect: true },
];

console.log('');
for (const testCase of groundCases) {
  groundMesh.position.set(0, testCase.pos, 0);
  groundMesh.rotation.set(0, 0, testCase.rot);
  const actual = belowGround();
  const ok = actual === testCase.expect;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} surface: ${testCase.name.padEnd(22)} expected ${testCase.expect}, got ${actual}`,
  );
}

console.log(failures === 0 ? '\nCollision math verified.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
