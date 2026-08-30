/**
 * Checks that delimited imports land on the same code paths as their JSON
 * equivalents: a pose capture must still be recognised and retargeted, and a
 * joint-state table must still parse to the same angles.
 *
 * Usage: node scripts/verify-csv.mjs [poseCapture.json]
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('./ts-loader.mjs', import.meta.url);

const { parseTrajectoryFile } = await import('../src/io/playbackSource.ts');
const { parseDelimited, looksDelimited } = await import('../src/io/csv.ts');
const { isPoseCapture, retargetPoseCapture } = await import('../src/io/poseRetarget.ts');
const { parseJointStatePayload } = await import('../src/io/parse.ts');
const { so101 } = await import('../src/robots/definitions/so101.ts');

let failures = 0;
const check = (name, condition, detail = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!condition) failures += 1;
};

// --- parser behaviour --------------------------------------------------

console.log('delimited parsing:');

const basic = parseDelimited('a,b,c\n1,2,3\n4,5,6\n');
check('comma separated', basic.length === 2 && basic[0].b === '2');

const tabbed = parseDelimited('a\tb\n1\t2\n');
check('tab separated', tabbed.length === 1 && tabbed[0].b === '2');

const semi = parseDelimited('a;b\n1;2\n');
check('semicolon separated', semi.length === 1 && semi[0].b === '2');

const quoted = parseDelimited('a,b\n"x,y",2\n');
check('quoted field with a comma', quoted[0].a === 'x,y', `got "${quoted[0].a}"`);

const escaped = parseDelimited('a,b\n"say ""hi""",2\n');
check('doubled quotes', escaped[0].a === 'say "hi"', `got "${escaped[0].a}"`);

const crlf = parseDelimited('a,b\r\n1,2\r\n');
check('CRLF line endings', crlf.length === 1 && crlf[0].b === '2');

const bom = parseDelimited('\uFEFFa,b\n1,2\n');
check('leading byte-order mark', Object.keys(bom[0])[0] === 'a', `got "${Object.keys(bom[0])[0]}"`);

const blanks = parseDelimited('a,b\n\n1,2\n\n');
check('blank lines skipped', blanks.length === 1);

const ragged = parseDelimited('a,b,c\n1,2\n');
check('short row padded', ragged[0].c === '', `got "${ragged[0].c}"`);

const headerOnly = parseDelimited('a,b\n');
check('header with no data rows', headerOnly.length === 0);

check('JSON is not treated as delimited', !looksDelimited('[{"a":1,"b":2}]'));
check('JSON Lines is not treated as delimited', !looksDelimited('{"a":1,"b":2}\n{"a":3,"b":4}'));
check('CSV is detected', looksDelimited('a,b\n1,2'));

// --- joint states as CSV ----------------------------------------------

console.log('\njoint states:');

const jointCsv = [
  'timestamp,unit,shoulder_pan,shoulder_lift,elbow_flex,wrist_flex,wrist_roll,gripper',
  '0.0,deg,10,-20,30,-5,15,50',
  '0.033,deg,12,-18,28,-4,16,55',
].join('\n');

const jointRecords = parseTrajectoryFile(jointCsv);
check('rows parsed', jointRecords.length === 2, `${jointRecords.length} rows`);
check('not mistaken for a pose capture', !isPoseCapture(jointRecords));

const frame = parseJointStatePayload(jointRecords[0], so101);
const panDeg = (frame.positions.shoulder_pan * 180) / Math.PI;
check('degrees converted', Math.abs(panDeg - 10) < 1e-6, `shoulder_pan ${panDeg.toFixed(3)}deg`);
check('timestamp read as seconds', frame.sentAt === 0, `sentAt ${frame.sentAt}`);
check(
  'gripper read on its normalised scale',
  frame.positions.gripper > 0.7 && frame.positions.gripper < 0.95,
  `gripper ${frame.positions.gripper.toFixed(3)} rad`,
);
check('no unmatched columns', frame.unmatchedKeys.length === 0, frame.unmatchedKeys.join(','));

// --- a pose capture converted to CSV ----------------------------------

const source = process.argv[2];
if (source) {
  console.log('\npose capture, JSON against CSV:');

  const json = JSON.parse(readFileSync(source, 'utf8'));
  const headers = Object.keys(json[0]);
  const csv = [
    headers.join(','),
    ...json.map((row) => headers.map((key) => row[key]).join(',')),
  ].join('\n');

  const viaCsv = parseTrajectoryFile(csv);
  check('row count preserved', viaCsv.length === json.length, `${viaCsv.length} vs ${json.length}`);
  check('recognised as a pose capture', isPoseCapture(viaCsv));

  const fromJson = retargetPoseCapture(json, { robot: so101, side: 'auto', mapping: 'fit' });
  const fromCsv = retargetPoseCapture(viaCsv, { robot: so101, side: 'auto', mapping: 'fit' });

  check('same arm chosen', fromJson.side === fromCsv.side, `${fromJson.side} vs ${fromCsv.side}`);
  check(
    'same usable frame count',
    fromJson.usableFrames === fromCsv.usableFrames,
    `${fromJson.usableFrames} vs ${fromCsv.usableFrames}`,
  );

  let worst = 0;
  for (let i = 0; i < fromJson.records.length; i += 1) {
    for (const joint of ['shoulder_pan', 'shoulder_lift', 'elbow_flex']) {
      worst = Math.max(worst, Math.abs(fromJson.records[i][joint] - fromCsv.records[i][joint]));
    }
  }
  check('identical joint angles', worst < 1e-9, `largest difference ${worst.toExponential(2)} rad`);
} else {
  console.log('\n(pass a pose capture path to compare JSON and CSV retargeting)');
}

console.log(failures === 0 ? '\nCSV import verified.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
