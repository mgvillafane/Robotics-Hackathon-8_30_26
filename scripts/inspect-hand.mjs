/**
 * Exploratory look at a hand-tracking CSV: detection rate, gripper scale,
 * palm-orientation range, and wrist motion. Used to choose retargeting
 * defaults rather than guessing at them.
 *
 * Usage: node scripts/inspect-hand.mjs <file.csv>
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./ts-loader.mjs', import.meta.url);
const { parseTrajectoryFile } = await import('../src/io/playbackSource.ts');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/inspect-hand.mjs <file.csv>');
  process.exit(1);
}

const frames = parseTrajectoryFile(readFileSync(file, 'utf8'));
const num = (record, key) => Number(record[key]);
const ok = (n) => Number.isFinite(n);

console.log(`frames: ${frames.length}`);
console.log(`duration: ${Number(frames[frames.length - 1].timestamp).toFixed(1)} s`);

const detected = frames.filter((f) => String(f.hand_detected).toLowerCase() === 'true');
console.log(`hand_detected=true: ${detected.length} (${((detected.length / frames.length) * 100).toFixed(1)}%)`);

const labels = {};
for (const f of detected) {
  const label = String(f.hand_label || '').toLowerCase() || '(empty)';
  labels[label] = (labels[label] ?? 0) + 1;
}
console.log('hand_label:', labels);

const otherLabels = {};
for (const f of frames) {
  const label = String(f.other_hand_label || '').trim();
  if (!label) continue;
  otherLabels[label] = (otherLabels[label] ?? 0) + 1;
}
console.log('other_hand_label (non-empty):', otherLabels);

const states = {};
for (const f of frames) {
  const state = String(f.gripper_state || '(empty)');
  states[state] = (states[state] ?? 0) + 1;
}
console.log('gripper_state:', states);

function stats(name, values) {
  const nums = values.filter(ok);
  if (nums.length === 0) {
    console.log(`  ${name}: no finite values`);
    return;
  }
  nums.sort((a, b) => a - b);
  const q = (p) => nums[Math.floor(p * (nums.length - 1))];
  console.log(
    `  ${name.padEnd(28)} n=${nums.length}  min ${q(0).toFixed(4)}  p5 ${q(0.05).toFixed(4)}  med ${q(0.5).toFixed(4)}  p95 ${q(0.95).toFixed(4)}  max ${q(1).toFixed(4)}`,
  );
}

console.log('\nscalars over detected frames:');
for (const key of [
  'detection_confidence',
  'tracking_confidence',
  'thumb_index_distance',
  'hand_scale',
  'hand_scale_raw',
  'normalized_gripper_distance',
  'smoothed_normalized_distance',
  'gripper_value',
  'wrist_x',
  'wrist_y',
  'wrist_z',
  'thumb_x',
  'index_x',
]) {
  stats(key, detected.map((f) => num(f, key)));
}

const reasons = {};
for (const f of frames) {
  const reason = String(f.selection_reason || '(empty)');
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}
console.log('\nselection_reason:', reasons);

// Palm plane: wrist -> midpoint of MCPs as "forward", index_mcp-middle_mcp as "across".
const flex = [];
const roll = [];
for (const f of detected) {
  const w = { x: num(f, 'wrist_x'), y: num(f, 'wrist_y'), z: num(f, 'wrist_z') };
  const i = { x: num(f, 'index_mcp_x'), y: num(f, 'index_mcp_y'), z: num(f, 'index_mcp_z') };
  const m = { x: num(f, 'middle_mcp_x'), y: num(f, 'middle_mcp_y'), z: num(f, 'middle_mcp_z') };
  if (![w.x, w.y, w.z, i.x, i.y, i.z, m.x, m.y, m.z].every(ok)) continue;

  const mid = { x: (i.x + m.x) / 2, y: (i.y + m.y) / 2, z: (i.z + m.z) / 2 };
  const fwd = { x: mid.x - w.x, y: mid.y - w.y, z: mid.z - w.z };
  const across = { x: i.x - m.x, y: i.y - m.y, z: i.z - m.z };
  const fl = Math.hypot(fwd.x, fwd.y, fwd.z);
  const al = Math.hypot(across.x, across.y, across.z);
  if (fl < 1e-6 || al < 1e-6) continue;
  flex.push(Math.atan2(fwd.y, Math.hypot(fwd.x, fwd.z)));
  roll.push(Math.atan2(across.y, across.x));
}

const deg = (r) => (r * 180) / Math.PI;
const summarize = (arr, name) => {
  if (arr.length === 0) return console.log(`  ${name}: none`);
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => deg(s[Math.floor(p * (s.length - 1))]);
  console.log(`  ${name.padEnd(12)} p5 ${q(0.05).toFixed(0)}  med ${q(0.5).toFixed(0)}  p95 ${q(0.95).toFixed(0)}  n=${arr.length}`);
};

console.log('\npalm orientation (image-ish axes, exploratory):');
summarize(flex, 'flex');
summarize(roll, 'roll');

let gap = 0;
let longest = 0;
for (const f of frames) {
  if (String(f.hand_detected).toLowerCase() === 'true') gap = 0;
  else longest = Math.max(longest, (gap += 1));
}
console.log(`\nlongest dropout: ${longest} frames`);
