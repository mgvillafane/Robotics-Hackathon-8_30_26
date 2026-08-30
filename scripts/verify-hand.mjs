/**
 * Runs a hand-tracking CSV through the retargeter and checks the result is
 * usable: inside the joint limits, gripper following the file's 0–1 column,
 * and no per-frame jumps a real arm could not follow.
 *
 * Usage: node scripts/verify-hand.mjs <frames.csv> [left|right|auto] [fit|direct|ik]
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./ts-loader.mjs', import.meta.url);

const [file, sideArg = 'auto', mappingArg = 'fit'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/verify-hand.mjs <frames.csv> [side] [mapping]');
  process.exit(1);
}

const { parseTrajectoryFile } = await import('../src/io/playbackSource.ts');
const { isHandCapture, retargetHandCapture } = await import('../src/io/handRetarget.ts');
const { isPoseCapture } = await import('../src/io/poseRetarget.ts');
const { so101 } = await import('../src/robots/definitions/so101.ts');

const records = parseTrajectoryFile(readFileSync(file, 'utf8'));
console.log(`file: ${file}`);
console.log(`recognised as a hand capture: ${isHandCapture(records)}`);
console.log(`mistaken for a pose capture: ${isPoseCapture(records)}`);

const result = retargetHandCapture(records, {
  robot: so101,
  side: sideArg,
  mapping: mappingArg,
});

const DEG = 180 / Math.PI;
console.log(`\nside: ${result.side}   mapping: ${result.mapping}   gripper: ${result.gripperSource}`);
console.log(
  `frames: ${result.totalFrames} total, ${result.detectedFrames} detected, ${result.usableFrames} usable`,
);
console.log(`longest gap: ${result.longestGapFrames} frames`);
console.log(
  `tracking estimate  left: ${result.tracking.left}  right: ${result.tracking.right}`,
);

const useIk = mappingArg === 'ik';
const driven = useIk
  ? ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_roll', 'gripper']
  : ['wrist_flex', 'wrist_roll', 'gripper'];
const mustStayOut = useIk ? [] : ['shoulder_pan', 'shoulder_lift', 'elbow_flex'];
const mustBePresent = useIk ? ['shoulder_pan', 'shoulder_lift', 'elbow_flex'] : [];
let failures = 0;

const times = result.records.map((record) => record.timestamp);
const contiguous = times.map((t, i) => i > 0 && t - times[i - 1] < 0.1);
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
  let harshSteps = 0;
  for (let i = 1; i < values.length; i += 1) {
    const step = Math.abs(values[i] - values[i - 1]);
    if (contiguous[i]) {
      maxStep = Math.max(maxStep, step);
      if (name !== 'gripper' && step * DEG > MAX_TRACKABLE_STEP_DEG) harshSteps += 1;
    }
  }

  console.log(
    `  ${name.padEnd(14)} ${(min * DEG).toFixed(0).padStart(5)}..${(max * DEG).toFixed(0).padStart(4)}deg` +
      `  uses ${(span * 100).toFixed(0)}% of travel` +
      `  max step ${(maxStep * DEG).toFixed(1).padStart(5)}deg` +
      `  outside limits: ${outside}`,
  );

  if (outside > 0) {
    console.log(`    FAIL ${outside} frame(s) outside the joint limits`);
    failures += 1;
  }
  const skipSpan = name === 'gripper' || (useIk && name === 'elbow_flex');
  if (span < 0.1 && !skipSpan) {
    console.log('    FAIL uses under 10% of the joint travel, motion would be invisible');
    failures += 1;
  }
  if (!values.every(Number.isFinite)) {
    console.log('    FAIL non-finite values reached the output');
    failures += 1;
  }
  if (harshSteps > 0) {
    console.log(`    FAIL ${harshSteps} step(s) over ${MAX_TRACKABLE_STEP_DEG}deg between consecutive frames`);
    failures += 1;
  }
}

if (mustStayOut.length > 0) {
  console.log('\nproximal joints must be absent:');
  for (const name of mustStayOut) {
    const written = result.records.filter((record) => record[name] !== undefined).length;
    console.log(`  ${name.padEnd(14)} written on ${written} frames`);
    if (written > 0) {
      console.log(`    FAIL ${name} was written; a hand capture must not move joints it does not measure`);
      failures += 1;
    }
  }
}

if (mustBePresent.length > 0) {
  console.log('\nIK must write the arm joints:');
  for (const name of mustBePresent) {
    const written = result.records.filter((record) => Number.isFinite(record[name])).length;
    console.log(`  ${name.padEnd(14)} written on ${written} / ${result.records.length} frames`);
    if (written !== result.records.length) {
      console.log(`    FAIL ${name} missing on ${result.records.length - written} frame(s)`);
      failures += 1;
    }
  }
  if (typeof result.ikSolved === 'number') {
    const ratio = result.ikSolved / Math.max(1, result.usableFrames);
    console.log(`  in-reach solutions: ${result.ikSolved} / ${result.usableFrames} (${(ratio * 100).toFixed(0)}%)`);
    if (ratio < 0.5) {
      console.log('    FAIL fewer than half of the usable frames landed in reach');
      failures += 1;
    }
  }
}

if (result.gripperSource === 'gripper_value') {
  const gripperJoint = so101.joints.find((entry) => entry.urdfName === 'gripper');
  const travel = gripperJoint.upper - gripperJoint.lower;
  const openings = result.records.map((record) => (record.gripper - gripperJoint.lower) / travel);
  const closed = openings.filter((v) => v < 0.15).length;
  const open = openings.filter((v) => v > 0.85).length;
  console.log(`\ngripper openings: ${(100 * closed / openings.length).toFixed(0)}% near closed, ${(100 * open / openings.length).toFixed(0)}% near open`);
  if (closed === 0 || open === 0) {
    console.log('    FAIL gripper never reaches both ends of its range');
    failures += 1;
  }
}

if (!isHandCapture(records)) {
  console.log('FAIL file was not recognised as a hand capture');
  failures += 1;
}
if (isPoseCapture(records)) {
  console.log('FAIL hand file was also classified as a pose capture');
  failures += 1;
}

console.log(failures === 0 ? '\nHand retargeting looks usable.' : `\n${failures} problem(s).`);
process.exit(failures === 0 ? 0 : 1);
