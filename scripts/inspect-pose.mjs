/**
 * Exploratory look at a MediaPipe pose capture: landmark visibility, the
 * stability of the torso frame, and the range of human arm angles. Used to
 * choose sane retargeting defaults rather than guessing at them.
 *
 * Usage: node scripts/inspect-pose.mjs <file.json>
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./ts-loader.mjs', import.meta.url);
const { parseTrajectoryFile } = await import('../src/io/playbackSource.ts');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/inspect-pose.mjs <capture.json|.csv|.jsonl>');
  process.exit(1);
}

const frames = parseTrajectoryFile(readFileSync(file, 'utf8'));

// Dropped frames are written as the string "nan", so every read has to be
// checked rather than trusted; NaN comparisons silently pass every gate.
const point = (frame, name) => {
  const p = {
    x: Number(frame[`${name}_x`]),
    y: Number(frame[`${name}_y`]),
    z: Number(frame[`${name}_z`]),
    v: Number(frame[`${name}_visibility`]),
  };
  p.ok = Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  return p;
};

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const len = (a) => Math.hypot(a.x, a.y, a.z);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

const NAMES = [
  'nose',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
];

console.log(`frames: ${frames.length}`);
console.log(`duration: ${Number(frames[frames.length - 1].timestamp).toFixed(1)} s`);

const detected = frames.filter((f) => point(f, 'left_shoulder').ok);
console.log(`frames with a detection: ${detected.length} (${((detected.length / frames.length) * 100).toFixed(1)}%)`);

// Longest run of consecutive dropped frames, which decides whether holding the
// last good pose is acceptable or whether gaps need to be skipped outright.
let gap = 0;
let longestGap = 0;
for (const f of frames) {
  if (point(f, 'left_shoulder').ok) gap = 0;
  else longestGap = Math.max(longestGap, (gap += 1));
}
console.log(`longest dropout: ${longestGap} frames (~${(longestGap / 30).toFixed(1)} s)`);

console.log('\nvisibility over detected frames:');
for (const name of NAMES) {
  const values = detected.map((f) => point(f, name).v).filter(Number.isFinite);
  const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  const good = values.filter((v) => v > 0.5).length / (values.length || 1);
  console.log(
    `  ${name.padEnd(15)} ${mean.toFixed(3)}   above 0.5 in ${(good * 100).toFixed(1)}% of detected`,
  );
}

// Torso axis: hips -> shoulders. Which image axis does the body lie along?
const axis = { x: 0, y: 0, z: 0 };
let torsoLenSum = 0;
let torsoFrames = 0;
for (const f of frames) {
  const ls = point(f, 'left_shoulder');
  const rs = point(f, 'right_shoulder');
  const lh = point(f, 'left_hip');
  const rh = point(f, 'right_hip');
  if (!ls.ok || !rs.ok || !lh.ok || !rh.ok) continue;

  const v = sub(mid(ls, rs), mid(lh, rh));
  const l = len(v);
  if (l < 1e-6) continue;
  torsoLenSum += l;
  torsoFrames += 1;
  axis.x += Math.abs(v.x) / l;
  axis.y += Math.abs(v.y) / l;
  axis.z += Math.abs(v.z) / l;
}
const n = frames.length;
console.log(`\ntorso frame available in ${torsoFrames} frames`);
console.log('torso axis (hips -> shoulders), mean |component|:');
console.log(
  `  x ${(axis.x / torsoFrames).toFixed(3)}   y ${(axis.y / torsoFrames).toFixed(3)}   z ${(axis.z / torsoFrames).toFixed(3)}`,
);
console.log(`  mean torso length: ${(torsoLenSum / torsoFrames).toFixed(3)} (normalized units)`);

// Human arm angles in a torso-relative frame, per side.
for (const side of ['left', 'right']) {
  const other = side === 'left' ? 'right' : 'left';
  const elbowAngles = [];
  const lifts = [];
  const pans = [];
  let usable = 0;

  for (const f of frames) {
    const shoulder = point(f, `${side}_shoulder`);
    const elbow = point(f, `${side}_elbow`);
    const wrist = point(f, `${side}_wrist`);
    if (!shoulder.ok || !elbow.ok || !wrist.ok) continue;
    if (Math.min(shoulder.v, elbow.v, wrist.v) < 0.5) continue;

    const ls = point(f, 'left_shoulder');
    const rs = point(f, 'right_shoulder');
    const lh = point(f, 'left_hip');
    const rh = point(f, 'right_hip');
    if (!ls.ok || !rs.ok || !lh.ok || !rh.ok) continue;

    const up = sub(mid(ls, rs), mid(lh, rh));
    const upLen = len(up);
    if (upLen < 1e-6) continue;
    const u = { x: up.x / upLen, y: up.y / upLen, z: up.z / upLen };

    // Across the shoulders, pointing away from the active side's body centre.
    const acrossRaw = sub(shoulder, point(f, `${other}_shoulder`));
    // Remove any component along the torso axis so the frame is orthogonal.
    const aDot = dot(acrossRaw, u);
    const a = {
      x: acrossRaw.x - aDot * u.x,
      y: acrossRaw.y - aDot * u.y,
      z: acrossRaw.z - aDot * u.z,
    };
    const aLen = len(a);
    if (aLen < 1e-6) continue;
    a.x /= aLen;
    a.y /= aLen;
    a.z /= aLen;

    // forward = across x up
    const fwd = {
      x: a.y * u.z - a.z * u.y,
      y: a.z * u.x - a.x * u.z,
      z: a.x * u.y - a.y * u.x,
    };

    const upper = sub(elbow, shoulder);
    const fore = sub(wrist, elbow);

    const uc = dot(upper, u);
    const ac = dot(upper, a);
    const fc = dot(upper, fwd);

    pans.push(Math.atan2(fc, ac));
    lifts.push(Math.atan2(uc, Math.hypot(ac, fc)));

    const cos = dot(upper, fore) / (len(upper) * len(fore));
    elbowAngles.push(Math.acos(Math.max(-1, Math.min(1, cos))));
    usable += 1;
  }

  const deg = (r) => (r * 180) / Math.PI;
  const stats = (arr) => {
    if (arr.length === 0) return 'n/a';
    const sorted = [...arr].sort((x, y) => x - y);
    const q = (p) => deg(sorted[Math.floor(p * (sorted.length - 1))]);
    return `p5 ${q(0.05).toFixed(0)}  median ${q(0.5).toFixed(0)}  p95 ${q(0.95).toFixed(0)}`;
  };

  console.log(`\n${side} arm: ${usable} usable frames (${((usable / n) * 100).toFixed(1)}%)`);
  console.log(`  pan (azimuth in torso plane)  ${stats(pans)}`);
  console.log(`  lift (elevation)              ${stats(lifts)}`);
  console.log(`  elbow bend from straight      ${stats(elbowAngles.map((x) => Math.PI - x))}`);
}
