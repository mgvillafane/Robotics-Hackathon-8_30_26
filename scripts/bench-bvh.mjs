import { readFileSync, readdirSync } from 'node:fs';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { MeshBVH } from 'three-mesh-bvh';

const dir = 'public/robots/so101/assets';
const loader = new STLLoader();
let totalTris = 0;
let totalBuild = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith('.stl'))) {
  const buffer = readFileSync(`${dir}/${file}`);
  const geometry = loader.parse(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
  const tris = geometry.getAttribute('position').count / 3;

  const start = performance.now();
  new MeshBVH(geometry);
  const ms = performance.now() - start;

  totalTris += tris;
  totalBuild += ms;
  console.log(`${file.padEnd(42)} ${String(Math.round(tris)).padStart(7)} tris  ${ms.toFixed(1)} ms`);
}

console.log(`\ntotal: ${Math.round(totalTris)} triangles, BVH build ${totalBuild.toFixed(0)} ms`);
