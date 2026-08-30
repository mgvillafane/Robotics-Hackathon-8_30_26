/**
 * Checks the 3-DOF SO-101 solver: a target inside the workspace should come
 * back from FK(IK(p)) within a centimetre, and an optional hand CSV should
 * produce in-reach solutions on both sides.
 *
 * Usage: node scripts/verify-ik.mjs [frames.csv]
 */
import { register } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';

register('./ts-loader.mjs', import.meta.url);

const { so101Fk, solveSo101Ik, SO101_WORKSPACE, landmarkToWorkspace, percentileRange, workspaceForApproach } =
  await import('../src/io/so101Ik.ts');

const file = process.argv[2];
let failures = 0;

function check(ok, message) {
  console.log(`${ok ? '  ok' : 'FAIL'}  ${message}`);
  if (!ok) failures += 1;
}

const samples = [];
const [x0, x1] = SO101_WORKSPACE.x;
const [y0, y1] = SO101_WORKSPACE.y;
const [z0, z1] = SO101_WORKSPACE.z;
for (let i = 0; i < 80; i += 1) {
  const t = i / 79;
  samples.push({
    x: x0 + (x1 - x0) * t,
    y: y0 + (y1 - y0) * ((i * 7) % 80) / 79,
    z: z0 + (z1 - z0) * ((i * 13) % 80) / 79,
  });
}

console.log('FK(IK(p)) on workspace samples:');
let worst = 0;
let unreachable = 0;
for (const target of samples) {
  const solution = solveSo101Ik(target);
  const reached = so101Fk(solution.shoulder_pan, solution.shoulder_lift, solution.elbow_flex);
  const error = Math.hypot(reached.x - target.x, reached.y - target.y, reached.z - target.z);
  worst = Math.max(worst, error);
  if (!solution.reachable) unreachable += 1;
}

console.log(`  worst FK error: ${(worst * 1000).toFixed(1)} mm   unreachable: ${unreachable} / ${samples.length}`);
check(worst < 0.012, 'worst reconstructed error is under 12 mm');
check(unreachable === 0, 'every workspace sample was in reach');

const home = so101Fk(0, 0, 0);
const homeIk = solveSo101Ik(home);
const homeBack = so101Fk(homeIk.shoulder_pan, homeIk.shoulder_lift, homeIk.elbow_flex);
const homeError = Math.hypot(homeBack.x - home.x, homeBack.y - home.y, homeBack.z - home.z);
check(homeError < 0.002, `straight-arm pose reconstructs (${(homeError * 1000).toFixed(1)} mm)`);

const farBox = workspaceForApproach(0);
const nearBox = workspaceForApproach(0.1);
check(nearBox.x[0] < farBox.x[0] && nearBox.x[1] < farBox.x[1], 'approach slides the IK box toward the base');

if (file) {
  if (!existsSync(file)) {
    check(false, `capture not found: ${file}`);
  } else {
    const { parseTrajectoryFile } = await import('../src/io/playbackSource.ts');
    const { retargetHandCapture } = await import('../src/io/handRetarget.ts');
    const { so101 } = await import('../src/robots/definitions/so101.ts');
    const records = parseTrajectoryFile(readFileSync(file, 'utf8'));

    console.log(`\nhand capture ${file}:`);
    for (const side of ['left', 'right']) {
      const result = retargetHandCapture(records, { robot: so101, side, mapping: 'ik' });
      const closer = retargetHandCapture(records, { robot: so101, side, mapping: 'ik', approach: 0.1 });
      const ratio = result.ikSolved / Math.max(1, result.usableFrames);
      const elbowFar = result.records.reduce((sum, record) => sum + record.elbow_flex, 0) / result.records.length;
      const elbowNear = closer.records.reduce((sum, record) => sum + record.elbow_flex, 0) / closer.records.length;
      const wristNear = closer.records.reduce((sum, record) => sum + (record.wrist_flex ?? 0), 0) / closer.records.length;
      console.log(
        `  ${side}: ${result.usableFrames} usable, ${result.ikSolved} in reach (${(ratio * 100).toFixed(0)}%)` +
          `  elbow ${((elbowNear - elbowFar) * 180 / Math.PI).toFixed(1)}deg  wrist ${(wristNear * 180 / Math.PI).toFixed(0)}deg`,
      );
      check(result.usableFrames > 0, `${side} produced usable IK frames`);
      check(ratio >= 0.5, `${side} has at least half of its frames in reach`);
      check(
        Math.abs(elbowNear - elbowFar) > 0.4,
        `${side} IK elbow folds by more than 23deg at 10 cm approach`,
      );
      check(Math.abs(wristNear) > 0.4, `${side} wrist tucks when approach is 10 cm`);
    }

    const observed = {
      x: percentileRange([-1, 1]),
      y: percentileRange([-1, 1]),
      z: percentileRange([-0.1, 0.1]),
    };
    const mapped = landmarkToWorkspace({ x: 0, y: 0, z: 0 }, observed);
    check(Number.isFinite(mapped.x) && Number.isFinite(mapped.y) && Number.isFinite(mapped.z), 'landmark map is finite');
  }
}

console.log(failures === 0 ? '\nIK solver looks usable.' : `\n${failures} problem(s).`);
process.exit(failures === 0 ? 0 : 1);
