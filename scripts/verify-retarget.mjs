/**
 * Runs a pose capture through the retargeter and checks the result is usable:
 * inside the joint limits, using a decent share of the travel, and free of
 * per-frame jumps that would look like teleporting.
 *
 * Usage: node scripts/verify-retarget.mjs <capture.json> [left|right|auto] [fit|direct]
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// The retargeter is TypeScript; strip types on the fly rather than duplicating it.
register('./ts-loader.mjs', import.meta.url);

const [file, sideArg = 'auto', mappingArg = 'fit'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/verify-retarget.mjs <capture.json|.csv> [side] [mapping]');
  process.exit(1);
}

const { retargetPoseCapture, isPoseCapture } = await import('../src/io/poseRetarget.ts');
const { parseTrajectoryFile } = await import('../src/io/playbackSource.ts');
const { so101 } = await import('../src/robots/definitions/so101.ts');

const records = parseTrajectoryFile(readFileSync(file, 'utf8'));
console.log(`file: ${file}`);
console.log(`recognised as a pose capture: ${isPoseCapture(records)}`);

const result = retargetPoseCapture(records, {
  robot: so101,
  side: sideArg,
  mapping: mappingArg,
});

const DEG = 180 / Math.PI;
console.log(`\nside: ${result.side}   mapping: ${result.mapping}`);
console.log(`frames: ${result.totalFrames} total, ${result.detectedFrames} detected, ${result.usableFrames} usable`);
console.log(`longest gap: ${result.longestGapFrames} frames`);

const driven = ['shoulder_pan', 'shoulder_lift', 'elbow_flex'];
let failures = 0;

// A large change right after a dropout is honest: the subject really did move
// while untracked. Only steps between consecutive captured frames are jumps.
const times = result.records.map((record) => record.timestamp);
const contiguous = times.map((t, i) => i > 0 && t - times[i - 1] < 0.1);

// Roughly the fastest an SO-101 joint moves, used to judge whether a per-frame
// step is something the real arm could follow.
const MAX_TRACKABLE_STEP_DEG = 25;

console.log('\nper joint:');
for (const name of driven) {
  const joint = so101.joints.find((entry) => entry.urdfName === name);
  const values = result.records.map((record) => record[name]);

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = (max - min) / (joint.upper - joint.lower);

  const outside = values.filter((v) => v < joint.lower - 1e-9 || v > joint.upper + 1e-9).length;

  let maxStep = 0;
  let maxGapStep = 0;
  let harshSteps = 0;
  for (let i = 1; i < values.length; i += 1) {
    const step = Math.abs(values[i] - values[i - 1]);
    if (contiguous[i]) {
      maxStep = Math.max(maxStep, step);
      if (step * DEG > MAX_TRACKABLE_STEP_DEG) harshSteps += 1;
    } else {
      maxGapStep = Math.max(maxGapStep, step);
    }
  }

  console.log(
    `  ${name.padEnd(14)} ${(min * DEG).toFixed(0).padStart(5)}..${(max * DEG).toFixed(0).padStart(4)}deg` +
      `  uses ${(span * 100).toFixed(0)}% of travel` +
      `  max step ${(maxStep * DEG).toFixed(1).padStart(5)}deg` +
      `  (across gaps ${(maxGapStep * DEG).toFixed(0)}deg)` +
      `  outside limits: ${outside}`,
  );

  if (outside > 0) {
    console.log(`    FAIL ${outside} frame(s) outside the joint limits`);
    failures += 1;
  }
  if (span < 0.1) {
    console.log('    FAIL uses under 10% of the joint travel, motion would be invisible');
    failures += 1;
  }
  if (!values.every(Number.isFinite)) {
    console.log('    FAIL non-finite values reached the output');
    failures += 1;
  }
  if (harshSteps > 0) {
    const share = ((harshSteps / values.length) * 100).toFixed(2);
    console.log(
      `    FAIL ${harshSteps} step(s) over ${MAX_TRACKABLE_STEP_DEG}deg between consecutive frames (${share}%)`,
    );
    failures += 1;
  }
}

const timestamps = result.records.map((record) => record.timestamp);
const monotonic = timestamps.every((t, i) => i === 0 || t >= timestamps[i - 1]);
console.log(`\ntimestamps monotonic: ${monotonic}`);
if (!monotonic) failures += 1;

if (result.mapping === 'fit') {
  console.log('\ncalibration (observed -> joint travel):');
  for (const [angle, range] of Object.entries(result.calibration)) {
    console.log(
      `  ${angle.padEnd(5)} ${(range.from[0] * DEG).toFixed(0).padStart(5)}..${(range.from[1] * DEG).toFixed(0).padStart(4)}deg` +
        ` -> ${(range.to[0] * DEG).toFixed(0).padStart(5)}..${(range.to[1] * DEG).toFixed(0).padStart(4)}deg`,
    );
  }
}

console.log(failures === 0 ? '\nRetargeting looks usable.' : `\n${failures} problem(s).`);
process.exit(failures === 0 ? 0 : 1);
