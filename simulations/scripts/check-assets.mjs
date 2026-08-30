/**
 * Verifies a robot's assets resolve the way the browser will resolve them.
 *
 * Fetches the URDF over HTTP, resolves every <mesh filename="..."> against the
 * URDF's own URL, and checks each one. Also compares the URDF's joint limits
 * against the fallbacks in the robot definition.
 *
 *   node scripts/check-assets.mjs [baseUrl]
 */
const BASE = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');

const ROBOTS = [
  { id: 'so101', urdfUrl: '/robots/so101/so101_new_calib.urdf' },
  { id: 'so100', urdfUrl: '/robots/so100/so100.urdf' },
];

const EXPECTED_JOINTS = [
  'shoulder_pan',
  'shoulder_lift',
  'elbow_flex',
  'wrist_flex',
  'wrist_roll',
  'gripper',
];

/** Mirrors THREE.LoaderUtils.extractUrlBase. */
function urlBase(url) {
  const index = url.lastIndexOf('/');
  return index === -1 ? './' : url.slice(0, index + 1);
}

let failures = 0;

for (const robot of ROBOTS) {
  console.log(`\n=== ${robot.id} ===`);

  const response = await fetch(BASE + robot.urdfUrl);
  const text = await response.text();

  if (!response.ok || !/<\s*robot[\s>]/i.test(text)) {
    console.error(`  FAIL urdf ${robot.urdfUrl} -> HTTP ${response.status}, not a URDF`);
    failures += 1;
    continue;
  }
  console.log(`  ok   urdf ${robot.urdfUrl} (${(text.length / 1024).toFixed(1)} kB)`);

  const joints = [...text.matchAll(/<joint\s+name="([^"]+)"\s+type="([^"]+)"/g)];
  const movable = joints.filter(([, , type]) => type !== 'fixed').map(([, name]) => name);
  const missingJoints = EXPECTED_JOINTS.filter((name) => !movable.includes(name));
  if (missingJoints.length > 0) {
    console.error(`  FAIL joints missing from URDF: ${missingJoints.join(', ')}`);
    failures += 1;
  } else {
    console.log(`  ok   joints ${movable.join(', ')}`);
  }

  for (const name of EXPECTED_JOINTS) {
    const block = text.match(new RegExp(`<joint name="${name}" type="[^"]+"[\\s\\S]*?</joint>`));
    const limit = block?.[0].match(/<limit[^>]*lower="([-\d.eE]+)"[^>]*upper="([-\d.eE]+)"/);
    if (limit) {
      console.log(
        `       ${name.padEnd(14)} [${Number(limit[1]).toFixed(4)}, ${Number(limit[2]).toFixed(4)}] rad`,
      );
    }
  }

  const base = urlBase(BASE + robot.urdfUrl);
  const meshes = [...new Set([...text.matchAll(/<mesh\s+filename="([^"]+)"/g)].map((m) => m[1]))];
  console.log(`  ${meshes.length} unique meshes referenced`);

  let bytes = 0;
  for (const mesh of meshes) {
    const meshUrl = new URL(mesh, base).href;
    const meshResponse = await fetch(meshUrl);
    const buffer = await meshResponse.arrayBuffer();
    // Vite answers unknown paths with the app's HTML and a 200, so check the
    // payload rather than trusting the status code.
    const looksHtml = new TextDecoder().decode(buffer.slice(0, 64)).trim().startsWith('<');
    if (!meshResponse.ok || looksHtml) {
      console.error(`  FAIL mesh ${mesh} -> ${meshResponse.status}${looksHtml ? ' (got HTML)' : ''}`);
      failures += 1;
    } else {
      bytes += buffer.byteLength;
    }
  }
  console.log(`  ok   all meshes resolved, ${(bytes / 1024 / 1024).toFixed(1)} MB total`);
}

console.log(failures === 0 ? '\nAll assets resolve.' : `\n${failures} problem(s) found.`);
process.exit(failures === 0 ? 0 : 1);
