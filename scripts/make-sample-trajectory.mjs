/**
 * Regenerates public/trajectories/so101_wave.jsonl, the clip the Playback panel
 * loads via its "Load sample" button.
 *
 *   node scripts/make-sample-trajectory.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { poseAt } from '../server/trajectory.mjs';

const FPS = 30;
const DURATION_SECONDS = 20;

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../public/trajectories/so101_wave.jsonl');

const round = (value) => Number(value.toFixed(5));

const lines = [];
for (let frame = 0; frame < FPS * DURATION_SECONDS; frame += 1) {
  const t = frame / FPS;
  const pose = poseAt(t);
  const positions = Object.fromEntries(
    Object.entries(pose).map(([joint, value]) => [joint, round(value)]),
  );
  lines.push(JSON.stringify({ t: round(t), unit: 'rad', positions }));
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');

console.log(`Wrote ${lines.length} frames to ${outputPath}`);
