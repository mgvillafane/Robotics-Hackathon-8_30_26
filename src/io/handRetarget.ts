import type { JointLimits } from './parse';
import type { RobotDefinition } from '../robots/types';
import type { ArmSide, PoseAngleRange, PoseMapping } from './poseRetarget';
import {
  applyApproachFold,
  landmarkToWorkspace,
  percentileRange,
  solveSo101Ik,
  workspaceForApproach,
  type FoldedIkSolution,
} from './so101Ik';

export type HandMapping = PoseMapping | 'ik';

/**
 * Turns a hand-tracking table into joint-state frames.
 *
 * The export this was written against is a 44-column CSV: one locked hand with
 * wrist / MCP / fingertip landmarks, a thinner record of the other hand, and a
 * `gripper_value` already scaled 0 (closed) to 1 (open). Wrist Z is the
 * MediaPipe Hands origin, so depth is only useful relative to the wrist; there
 * is no shoulder or elbow. In the default mappings those joints are left
 * untouched and only the palm (wrist flex / roll) and `gripper_value` are
 * written. Mapping `ik` instead sends the index tip through 3-DOF inverse
 * kinematics so the arm reaches for that point; MediaPipe Hands is not
 * metric, so the tip cloud is fitted into the robot workspace first.
 */

export type HandDerived = 'flex' | 'roll';

export interface HandRetargetOptions {
  robot: RobotDefinition;
  limits?: JointLimits;
  side?: ArmSide | 'auto';
  mapping?: HandMapping;
  /** Metres to pull IK targets toward the base so the arm is less stretched. */
  approach?: number;
}

export interface HandRetargetResult {
  records: Array<Record<string, number | string>>;
  side: ArmSide;
  mapping: HandMapping;
  totalFrames: number;
  detectedFrames: number;
  usableFrames: number;
  longestGapFrames: number;
  tracking: Record<ArmSide, number>;
  calibration: Partial<Record<HandDerived, PoseAngleRange>>;
  /** How the gripper opening was read from the file. */
  gripperSource: 'gripper_value' | 'pinch';
  /** Frames that got an in-reach IK solution. Only set in `ik` mode. */
  ikSolved?: number;
}

const JOINT_BY_ANGLE: Record<HandDerived, string> = {
  flex: 'wrist_flex',
  roll: 'wrist_roll',
};

/**
 * Flips a derived angle before it reaches the robot. Change these if a wrist
 * joint reads mirrored; they do not affect the gripper.
 */
const INVERT: Record<HandDerived, boolean> = {
  flex: false,
  roll: false,
};

const GAP_RESET_FRAMES = 5;
const SMOOTHING_ALPHA = 0.35;
const MAX_ANGULAR_RATE = 4.0;
const MIN_DT = 1 / 240;
const MAX_DT = 0.2;
const FIT_LOW = 0.02;
const FIT_HIGH = 0.98;
const FIT_MARGIN = 0.95;
const FIT_MAX_GAIN = 1.5;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mid = (a: Vec3, b: Vec3): Vec3 => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: (a.z + b.z) / 2,
});
const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

function normalize(a: Vec3): Vec3 | null {
  const l = length(a);
  return l > 1e-6 ? { x: a.x / l, y: a.y / l, z: a.z / l } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const raw = record[key];
  if (raw === '' || raw === null || raw === undefined) return Number.NaN;
  const text = String(raw).trim();
  if (text.length === 0 || text.toLowerCase() === 'nan') return Number.NaN;
  return Number(text);
}

function point(record: Record<string, unknown>, name: string): Vec3 | null {
  const x = readNumber(record, `${name}_x`);
  const y = readNumber(record, `${name}_y`);
  const z = readNumber(record, `${name}_z`);
  // Wrist Z is the Hands origin and sits at ~0; X/Y must still be finite.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, z: Number.isFinite(z) ? z : 0 };
}

function parseSide(value: unknown): ArmSide | null {
  const label = String(value ?? '').trim().toLowerCase();
  if (label === 'left') return 'left';
  if (label === 'right') return 'right';
  return null;
}

function truthyDetected(value: unknown): boolean {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

/**
 * True when these records look like the hand-tracking export rather than body
 * pose or joint states. Headers are present even on empty opening rows.
 */
export function isHandCapture(records: unknown[]): boolean {
  for (const record of records.slice(0, 20)) {
    if (!isRecord(record)) continue;
    const hasHand =
      'wrist_x' in record &&
      'thumb_x' in record &&
      ('hand_detected' in record || 'hand_label' in record || 'gripper_value' in record);
    if (hasHand) return true;
  }
  return false;
}

type HandPrefix = '' | 'other_';

function primaryPresent(record: Record<string, unknown>): boolean {
  return truthyDetected(record.hand_detected) && point(record, 'wrist') !== null;
}

function otherPresent(record: Record<string, unknown>): boolean {
  return point(record, 'other_wrist') !== null;
}

/** Which column set holds the requested side on this row, if either does. */
function viewForSide(record: Record<string, unknown>, side: ArmSide): HandPrefix | null {
  if (primaryPresent(record) && parseSide(record.hand_label) === side) return '';
  if (otherPresent(record) && parseSide(record.other_hand_label) === side) return 'other_';
  return null;
}

function countSide(records: unknown[], side: ArmSide): number {
  let count = 0;
  for (const record of records) {
    if (isRecord(record) && viewForSide(record, side) !== null) count += 1;
  }
  return count;
}

interface RawHand {
  values: Record<HandDerived, number> | null;
  index: Vec3 | null;
  gripper: number | null;
  /** True when gripper came from the file's own 0–1 column. */
  gripperCalibrated: boolean;
}

function palmAngles(acrossHint: Vec3, forwardHint: Vec3): { flex: number; roll: number } | null {
  const forward = normalize(forwardHint);
  const acrossRaw = acrossHint;
  if (!forward) return null;
  const along = acrossRaw.x * forward.x + acrossRaw.y * forward.y + acrossRaw.z * forward.z;
  const across = normalize({
    x: acrossRaw.x - along * forward.x,
    y: acrossRaw.y - along * forward.y,
    z: acrossRaw.z - along * forward.z,
  });
  if (!across) return null;

  return {
    // How far the palm points down the image versus out of the camera.
    flex: Math.atan2(forward.y, Math.hypot(forward.x, forward.z)),
    // Twist of the palm about the forearm.
    roll: Math.atan2(across.y, across.x),
  };
}

function frameHand(record: Record<string, unknown>, prefix: HandPrefix): RawHand | null {
  const wrist = point(record, `${prefix}wrist`);
  if (!wrist) return null;

  const indexMcp = point(record, `${prefix}index_mcp`);
  const middleMcp = point(record, `${prefix}middle_mcp`);
  const thumb = point(record, `${prefix}thumb`);
  const index = point(record, `${prefix}index`);

  let palm: { flex: number; roll: number } | null = null;
  if (indexMcp && middleMcp) {
    palm = palmAngles(sub(indexMcp, middleMcp), sub(mid(indexMcp, middleMcp), wrist));
  } else if (thumb && index) {
    // The other-hand columns omit MCPs; thumb/index still give a usable palm.
    palm = palmAngles(sub(index, thumb), sub(mid(thumb, index), wrist));
  }
  let gripper: number | null = null;
  let gripperCalibrated = false;
  if (prefix === '') {
    const value = readNumber(record, 'gripper_value');
    if (Number.isFinite(value)) {
      gripper = Math.min(1, Math.max(0, value));
      gripperCalibrated = true;
    }
  }
  if (gripper === null && thumb && index) {
    gripper = length(sub(index, thumb));
  }

  if (!palm && !index) return null;

  return {
    values: palm,
    index,
    gripper,
    gripperCalibrated,
  };
}

function wrapToPi(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function limitStep(previous: number, target: number, maxDelta: number): number {
  const delta = target - previous;
  return previous + Math.max(-maxDelta, Math.min(maxDelta, delta));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index];
}

export function retargetHandCapture(
  records: unknown[],
  options: HandRetargetOptions,
): HandRetargetResult {
  const { robot, limits, mapping = 'fit', approach = 0 } = options;
  const workspace = workspaceForApproach(approach);
  const requested = options.side ?? 'auto';

  const tracking: Record<ArmSide, number> = {
    left: countSide(records, 'left'),
    right: countSide(records, 'right'),
  };
  const side: ArmSide =
    requested === 'auto' ? (tracking.left >= tracking.right ? 'left' : 'right') : requested;

  const limitFor = (jointName: string) => {
    const fromUrdf = limits?.[jointName];
    if (fromUrdf && fromUrdf.upper > fromUrdf.lower) return fromUrdf;
    const joint = robot.joints.find((entry) => entry.urdfName === jointName);
    return joint ? { lower: joint.lower, upper: joint.upper } : { lower: -1, upper: 1 };
  };

  const useIk = mapping === 'ik';

  const samples: Array<{
    index: number;
    values: Record<HandDerived, number> | null;
    tip: Vec3 | null;
    gripper: number;
    gripperCalibrated: boolean;
  }> = [];
  let detectedFrames = 0;
  let previous: Record<HandDerived, number> | null = null;
  let lastIndex = -1;
  let lastTime: number | null = null;
  let calibratedGripperCount = 0;

  records.forEach((record, index) => {
    if (!isRecord(record)) return;
    if (primaryPresent(record) || otherPresent(record)) detectedFrames += 1;

    const prefix = viewForSide(record, side);
    if (prefix === null) return;
    const raw = frameHand(record, prefix);
    if (!raw || raw.gripper === null) return;
    if (useIk && !raw.index) return;
    if (!useIk && !raw.values) return;

    const time = Number(record.timestamp ?? record.t ?? record.time);
    const hasTime = Number.isFinite(time);

    let next: Record<HandDerived, number> | null = raw.values;
    if (raw.values) {
      if (previous === null || index - lastIndex > GAP_RESET_FRAMES) {
        next = { ...raw.values };
      } else {
        const eased: Record<HandDerived, number> = {
          flex: previous.flex + SMOOTHING_ALPHA * (raw.values.flex - previous.flex),
          roll: previous.roll + SMOOTHING_ALPHA * wrapToPi(raw.values.roll - previous.roll),
        };
        const dt =
          hasTime && lastTime !== null
            ? Math.min(MAX_DT, Math.max(MIN_DT, time - lastTime))
            : Math.min(MAX_DT, Math.max(MIN_DT, (index - lastIndex) / 30));
        const maxDelta = MAX_ANGULAR_RATE * dt;
        next = {
          flex: limitStep(previous.flex, eased.flex, maxDelta),
          roll: limitStep(previous.roll, eased.roll, maxDelta),
        };
      }
      previous = next;
    }

    lastIndex = index;
    if (hasTime) lastTime = time;
    if (raw.gripperCalibrated) calibratedGripperCount += 1;
    samples.push({
      index,
      values: next,
      tip: raw.index,
      gripper: raw.gripper,
      gripperCalibrated: raw.gripperCalibrated,
    });
  });

  let longestGapFrames = 0;
  let previousIndex = -1;
  for (const { index } of samples) {
    longestGapFrames = Math.max(longestGapFrames, index - previousIndex - 1);
    previousIndex = index;
  }
  longestGapFrames = Math.max(longestGapFrames, records.length - previousIndex - 1);

  const calibration: Partial<Record<HandDerived, PoseAngleRange>> = {};
  const wristMapping = mapping === 'ik' ? 'fit' : mapping;
  for (const angle of Object.keys(JOINT_BY_ANGLE) as HandDerived[]) {
    const sorted = samples
      .map((entry) => entry.values?.[angle])
      .filter((value): value is number => value !== undefined && Number.isFinite(value))
      .sort((a, b) => a - b);
    if (sorted.length === 0) continue;
    const from: [number, number] = [percentile(sorted, FIT_LOW), percentile(sorted, FIT_HIGH)];
    const limit = limitFor(JOINT_BY_ANGLE[angle]);
    const travel = (limit.upper - limit.lower) * FIT_MARGIN;
    const centre = (limit.lower + limit.upper) / 2;
    const inSpan = Math.max(0, from[1] - from[0]);
    const outSpan = Math.min(travel, wristMapping === 'fit' ? inSpan * FIT_MAX_GAIN : inSpan);
    const low = centre - outSpan / 2;
    const high = centre + outSpan / 2;
    calibration[angle] = { from, to: INVERT[angle] ? [high, low] : [low, high] };
  }

  const toJoint = (angle: HandDerived, value: number): number => {
    const range = calibration[angle];
    if (!range) return INVERT[angle] ? -value : value;
    const [inLow, inHigh] = range.from;
    const [outLow, outHigh] = range.to;
    if (inHigh - inLow < 1e-9) return (outLow + outHigh) / 2;
    const t = (value - inLow) / (inHigh - inLow);
    return outLow + Math.min(1, Math.max(0, t)) * (outHigh - outLow);
  };

  // gripper_value is already 0–1. Pinch distance is not, so it is fitted once.
  const gripperLimit = limitFor('gripper');
  const pinchDistances = samples
    .filter((entry) => !entry.gripperCalibrated)
    .map((entry) => entry.gripper)
    .sort((a, b) => a - b);
  const pinchFrom: [number, number] = [
    percentile(pinchDistances, FIT_LOW),
    percentile(pinchDistances, FIT_HIGH),
  ];

  const toGripper = (value: number, calibrated: boolean): number => {
    const open = calibrated
      ? Math.min(1, Math.max(0, value))
      : pinchFrom[1] - pinchFrom[0] < 1e-9
        ? 0.5
        : Math.min(1, Math.max(0, (value - pinchFrom[0]) / (pinchFrom[1] - pinchFrom[0])));
    return gripperLimit.lower + open * (gripperLimit.upper - gripperLimit.lower);
  };

  const observedTips = useIk
    ? {
        x: percentileRange(samples.map((entry) => entry.tip?.x).filter((v): v is number => Number.isFinite(v))),
        y: percentileRange(samples.map((entry) => entry.tip?.y).filter((v): v is number => Number.isFinite(v))),
        z: percentileRange(samples.map((entry) => entry.tip?.z).filter((v): v is number => Number.isFinite(v))),
      }
    : null;

  const ikLimits = {
    shoulder_pan: limitFor('shoulder_pan'),
    shoulder_lift: limitFor('shoulder_lift'),
    elbow_flex: limitFor('elbow_flex'),
  };

  let ikSolved = 0;
  let previousIk: FoldedIkSolution | null = null;
  let lastIkIndex = -1;
  let lastIkTime: number | null = null;

  const outputRecords = samples.map(({ index, values, tip, gripper, gripperCalibrated }) => {
    const source = records[index] as Record<string, unknown>;
    const timestamp = Number(source.timestamp ?? source.t ?? source.time);
    const record: Record<string, number | string> = { unit: 'rad' };
    if (Number.isFinite(timestamp)) record.timestamp = timestamp;

    if (useIk && tip && observedTips) {
      let solution = applyApproachFold(
        solveSo101Ik(landmarkToWorkspace(tip, observedTips, workspace), ikLimits),
        approach,
        ikLimits,
      );
      const gap = lastIkIndex >= 0 && index - lastIkIndex > GAP_RESET_FRAMES;
      if (previousIk && !gap) {
        const dt =
          Number.isFinite(timestamp) && lastIkTime !== null
            ? Math.min(MAX_DT, Math.max(MIN_DT, timestamp - lastIkTime))
            : Math.min(MAX_DT, Math.max(MIN_DT, (index - lastIkIndex) / 30));
        const maxDelta = MAX_ANGULAR_RATE * dt;
        solution = {
          shoulder_pan: limitStep(previousIk.shoulder_pan, solution.shoulder_pan, maxDelta),
          shoulder_lift: limitStep(previousIk.shoulder_lift, solution.shoulder_lift, maxDelta),
          elbow_flex: limitStep(previousIk.elbow_flex, solution.elbow_flex, maxDelta),
          wrist_flex: limitStep(previousIk.wrist_flex, solution.wrist_flex, maxDelta),
          reachable: solution.reachable,
        };
      }
      previousIk = solution;
      lastIkIndex = index;
      if (Number.isFinite(timestamp)) lastIkTime = timestamp;
      if (solution.reachable) ikSolved += 1;
      record.shoulder_pan = solution.shoulder_pan;
      record.shoulder_lift = solution.shoulder_lift;
      record.elbow_flex = solution.elbow_flex;
      record.wrist_flex = solution.wrist_flex;
      if (values) record.wrist_roll = toJoint('roll', values.roll);
    } else if (values) {
      for (const angle of Object.keys(JOINT_BY_ANGLE) as HandDerived[]) {
        record[JOINT_BY_ANGLE[angle]] = toJoint(angle, values[angle]);
      }
    }

    record.gripper = toGripper(gripper, gripperCalibrated);
    return record;
  });

  return {
    records: outputRecords,
    side,
    mapping,
    totalFrames: records.length,
    detectedFrames,
    usableFrames: samples.length,
    longestGapFrames,
    tracking,
    calibration,
    gripperSource: calibratedGripperCount >= samples.length / 2 ? 'gripper_value' : 'pinch',
    ...(useIk ? { ikSolved } : {}),
  };
}
