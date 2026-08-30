import type { JointLimits } from './parse';
import type { RobotDefinition } from '../robots/types';

/**
 * Turns a MediaPipe Pose capture into joint-state frames for an arm.
 *
 * The input is one record per video frame, with a flat `<landmark>_x/_y/_z/
 * _visibility` key per landmark. Only the shoulders, hips, and one arm's
 * shoulder/elbow/wrist are used; legs contribute nothing to an arm pose.
 *
 * Two properties of real captures drive the design:
 *
 * 1. Frames where the detector found nobody are written as the string "nan".
 *    Every read is therefore checked, because NaN silently passes comparisons
 *    like `value < threshold` and would otherwise poison the output.
 * 2. The subject is not reliably upright in the image. Angles are measured in a
 *    frame built from the body itself — the torso axis and the shoulder line —
 *    so a rotated camera or a reclining subject does not change the result.
 */

export type ArmSide = 'left' | 'right';

/**
 * Both modes centre the captured motion on the joint's mid-travel and differ
 * only in gain. `fit` stretches the observed range to fill the travel, which
 * guarantees visible motion from a subject who moved a little. `direct` keeps
 * the human's angular scale, so a 30-degree shoulder movement becomes a
 * 30-degree joint movement, compressing only if the range does not fit.
 */
export type PoseMapping = 'fit' | 'direct';

export interface PoseRetargetOptions {
  robot: RobotDefinition;
  limits?: JointLimits;
  /** `auto` picks whichever arm the detector tracked more reliably. */
  side?: ArmSide | 'auto';
  mapping?: PoseMapping;
  /** Landmark confidence below which a frame is discarded. */
  minVisibility?: number;
}

export interface PoseAngleRange {
  /** Observed angle window, in radians. */
  from: [number, number];
  /** Joint travel it was mapped onto, in radians. */
  to: [number, number];
}

export interface PoseRetargetResult {
  /** Joint-state records in radians, ready for the normal parser. */
  records: Array<Record<string, number | string>>;
  side: ArmSide;
  mapping: PoseMapping;
  totalFrames: number;
  /** Frames where the detector produced a skeleton at all. */
  detectedFrames: number;
  /** Frames that also passed the visibility gate for the chosen arm. */
  usableFrames: number;
  /** Longest run of consecutive unusable frames. */
  longestGapFrames: number;
  /**
   * Roughly how many frames each arm could be tracked in, so the choice between
   * them can be made on evidence. Estimated by sampling, so it will not match
   * `usableFrames` exactly even for the selected arm.
   */
  tracking: Record<ArmSide, number>;
  calibration: Partial<Record<DerivedAngle, PoseAngleRange>>;
}

/** The three arm angles a shoulder/elbow/wrist triple can actually support. */
export type DerivedAngle = 'pan' | 'lift' | 'bend';

/** Which SO-101 joint each derived angle drives. */
const JOINT_BY_ANGLE: Record<DerivedAngle, string> = {
  pan: 'shoulder_pan',
  lift: 'shoulder_lift',
  bend: 'elbow_flex',
};

/**
 * Flips a derived angle before it reaches the robot. These decide which way the
 * arm appears to move and are the first thing to change if the motion looks
 * mirrored; they do not affect the magnitude of the mapping.
 */
const INVERT: Record<DerivedAngle, boolean> = {
  pan: false,
  lift: false,
  bend: true,
};

/**
 * When the upper arm points nearly along the torso axis — an arm hanging at rest
 * — its heading around that axis is undefined, and landmark noise makes the
 * computed azimuth flip through large angles between frames. Below this
 * fraction of the arm's length projected into the shoulder plane, the previous
 * heading is held instead.
 */
const POLE_MIN_HORIZONTAL = 0.25;

/** Dropout length after which smoothing restarts rather than easing across it. */
const GAP_RESET_FRAMES = 5;

/**
 * Weight given to each new sample. Landmark jitter is significant at this
 * scale, so the raw angles are damped before they become joint targets; this is
 * separate from the display smoothing applied in the scene.
 */
const SMOOTHING_ALPHA = 0.35;

/**
 * Ceiling on how fast a retargeted angle may change, in radians per second.
 * Low-confidence elbow and wrist landmarks jump between frames, and damping
 * alone still lets a single bad sample through as a lurch. A real arm cannot
 * slew arbitrarily fast either, so the limit costs nothing in fidelity.
 */
const MAX_ANGULAR_RATE = 4.0;

/** Bounds on the inter-frame delta used for rate limiting, in seconds. */
const MIN_DT = 1 / 240;
const MAX_DT = 0.2;

/** Percentile window used by `fit`, trimming outliers from jittery landmarks. */
const FIT_LOW = 0.02;
const FIT_HIGH = 0.98;

/** Keeps `fit` output just inside the limits so it does not read as clamped. */
const FIT_MARGIN = 0.95;

/**
 * Ceiling on how much `fit` may stretch an angle. A subject who barely moved
 * produces a narrow, noisy range, and mapping that onto the full joint travel
 * would amplify landmark jitter into violent motion.
 */
const FIT_MAX_GAIN = 1.5;

const REQUIRED_LANDMARKS = [
  'left_shoulder',
  'right_shoulder',
  'left_hip',
  'right_hip',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
] as const;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Landmark extends Vec3 {
  visibility: number;
  /** False when the detector dropped this frame, i.e. the values read "nan". */
  ok: boolean;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mid = (a: Vec3, b: Vec3): Vec3 => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: (a.z + b.z) / 2,
});
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function normalize(a: Vec3): Vec3 | null {
  const l = length(a);
  return l > 1e-6 ? { x: a.x / l, y: a.y / l, z: a.z / l } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLandmark(record: Record<string, unknown>, name: string): Landmark {
  const x = Number(record[`${name}_x`]);
  const y = Number(record[`${name}_y`]);
  const z = Number(record[`${name}_z`]);
  const visibility = Number(record[`${name}_visibility`]);
  const ok = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
  return { x, y, z, visibility: Number.isFinite(visibility) ? visibility : 0, ok };
}

/**
 * True when these records look like a pose capture rather than joint states.
 * Checked against the first few records, since the opening frames of a capture
 * are often dropouts.
 */
export function isPoseCapture(records: unknown[]): boolean {
  for (const record of records.slice(0, 20)) {
    if (!isRecord(record)) continue;
    const hasAll = REQUIRED_LANDMARKS.every(
      (name) => `${name}_x` in record && `${name}_y` in record,
    );
    if (hasAll) return true;
  }
  return false;
}

/**
 * Body-relative axes for one arm. `across` points outward on the active side,
 * so the left and right arms produce mirrored angles and either can drive the
 * robot the same way.
 */
function torsoFrame(
  record: Record<string, unknown>,
  side: ArmSide,
  minVisibility: number,
): { across: Vec3; up: Vec3; forward: Vec3 } | null {
  const leftShoulder = readLandmark(record, 'left_shoulder');
  const rightShoulder = readLandmark(record, 'right_shoulder');
  const leftHip = readLandmark(record, 'left_hip');
  const rightHip = readLandmark(record, 'right_hip');

  for (const point of [leftShoulder, rightShoulder, leftHip, rightHip]) {
    if (!point.ok || point.visibility < minVisibility) return null;
  }

  const up = normalize(
    sub(mid(leftShoulder, rightShoulder), mid(leftHip, rightHip)),
  );
  if (!up) return null;

  const active = side === 'left' ? leftShoulder : rightShoulder;
  const other = side === 'left' ? rightShoulder : leftShoulder;

  // Project the shoulder line off the torso axis so the two are orthogonal.
  const raw = sub(active, other);
  const along = dot(raw, up);
  const across = normalize({
    x: raw.x - along * up.x,
    y: raw.y - along * up.y,
    z: raw.z - along * up.z,
  });
  if (!across) return null;

  return { across, up, forward: cross(across, up) };
}

interface RawAngles extends Record<DerivedAngle, number> {
  /**
   * How far the upper arm reaches into the shoulder plane, as a fraction of its
   * length. Near zero, `pan` is numerically meaningless.
   */
  horizontal: number;
}

/** Arm angles for one frame, or null if the frame cannot be trusted. */
function frameAngles(
  record: Record<string, unknown>,
  side: ArmSide,
  minVisibility: number,
): RawAngles | null {
  const shoulder = readLandmark(record, `${side}_shoulder`);
  const elbow = readLandmark(record, `${side}_elbow`);
  const wrist = readLandmark(record, `${side}_wrist`);

  for (const point of [shoulder, elbow, wrist]) {
    if (!point.ok || point.visibility < minVisibility) return null;
  }

  const frame = torsoFrame(record, side, minVisibility);
  if (!frame) return null;

  const upper = sub(elbow, shoulder);
  const fore = sub(wrist, elbow);
  const upperLength = length(upper);
  const foreLength = length(fore);
  if (upperLength < 1e-6 || foreLength < 1e-6) return null;

  const acrossPart = dot(upper, frame.across);
  const forwardPart = dot(upper, frame.forward);
  const upPart = dot(upper, frame.up);

  const cosElbow = dot(upper, fore) / (upperLength * foreLength);

  const horizontal = Math.hypot(acrossPart, forwardPart);

  return {
    // Azimuth of the upper arm around the torso axis.
    pan: Math.atan2(forwardPart, acrossPart),
    // Elevation of the upper arm above the shoulder plane.
    lift: Math.atan2(upPart, horizontal),
    // 0 when the arm is straight, growing as the elbow closes.
    bend: Math.PI - Math.acos(Math.max(-1, Math.min(1, cosElbow))),
    horizontal: horizontal / upperLength,
  };
}

/** Shortest signed representation of an angle difference. */
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

/**
 * Counts trackable frames for one arm. Only used to choose between arms, so it
 * samples rather than visiting every frame: tracking quality varies over
 * seconds, not single frames, and this runs twice before the real pass.
 */
function countUsable(
  records: unknown[],
  side: ArmSide,
  minVisibility: number,
  stride = 4,
): number {
  let count = 0;
  for (let i = 0; i < records.length; i += stride) {
    const record = records[i];
    if (isRecord(record) && frameAngles(record, side, minVisibility)) count += 1;
  }
  return count;
}

export function retargetPoseCapture(
  records: unknown[],
  options: PoseRetargetOptions,
): PoseRetargetResult {
  const { robot, limits, mapping = 'fit', minVisibility = 0.5 } = options;
  const requested = options.side ?? 'auto';

  const stride = 4;
  const sampled = {
    left: countUsable(records, 'left', minVisibility, stride),
    right: countUsable(records, 'right', minVisibility, stride),
  };
  const tracking: Record<ArmSide, number> = {
    left: sampled.left * stride,
    right: sampled.right * stride,
  };

  const side: ArmSide =
    requested === 'auto' ? (sampled.left >= sampled.right ? 'left' : 'right') : requested;

  const limitFor = (jointName: string) => {
    const fromUrdf = limits?.[jointName];
    if (fromUrdf && fromUrdf.upper > fromUrdf.lower) return fromUrdf;
    const joint = robot.joints.find((entry) => entry.urdfName === jointName);
    return joint ? { lower: joint.lower, upper: joint.upper } : { lower: -1, upper: 1 };
  };

  // First pass: derive angles and damp them in time. Source indices are kept so
  // dropouts leave real gaps rather than being silently compressed, and so
  // smoothing can restart instead of easing across a gap.
  const angles: Array<{ index: number; values: Record<DerivedAngle, number> }> = [];
  let detectedFrames = 0;
  let previous: Record<DerivedAngle, number> | null = null;
  let lastIndex = -1;
  let lastTime: number | null = null;

  records.forEach((record, index) => {
    if (!isRecord(record)) return;
    if (readLandmark(record, 'left_shoulder').ok) detectedFrames += 1;

    const raw = frameAngles(record, side, minVisibility);
    if (!raw) return;

    const time = Number(record.timestamp ?? record.t ?? record.time);
    const hasTime = Number.isFinite(time);

    let next: Record<DerivedAngle, number>;

    if (previous === null || index - lastIndex > GAP_RESET_FRAMES) {
      // Fresh start after a dropout: adopt the pose rather than easing into it
      // from a stale one that may be seconds old.
      next = { pan: raw.pan, lift: raw.lift, bend: raw.bend };
    } else {
      const panTarget = raw.horizontal < POLE_MIN_HORIZONTAL ? previous.pan : raw.pan;
      const eased: Record<DerivedAngle, number> = {
        // Stepping along the shortest arc, and deliberately not re-wrapping the
        // result: holding an unwrapped heading is what keeps the +/-180 seam
        // from reading as a sweep across the joint's whole travel.
        pan: previous.pan + SMOOTHING_ALPHA * wrapToPi(panTarget - previous.pan),
        lift: previous.lift + SMOOTHING_ALPHA * (raw.lift - previous.lift),
        bend: previous.bend + SMOOTHING_ALPHA * (raw.bend - previous.bend),
      };

      const dt =
        hasTime && lastTime !== null
          ? Math.min(MAX_DT, Math.max(MIN_DT, time - lastTime))
          : Math.min(MAX_DT, Math.max(MIN_DT, (index - lastIndex) / 30));
      const maxDelta = MAX_ANGULAR_RATE * dt;

      next = {
        pan: limitStep(previous.pan, eased.pan, maxDelta),
        lift: limitStep(previous.lift, eased.lift, maxDelta),
        bend: limitStep(previous.bend, eased.bend, maxDelta),
      };
    }

    previous = next;
    lastIndex = index;
    if (hasTime) lastTime = time;
    angles.push({ index, values: next });
  });

  let longestGapFrames = 0;
  let previousIndex = -1;
  for (const { index } of angles) {
    longestGapFrames = Math.max(longestGapFrames, index - previousIndex - 1);
    previousIndex = index;
  }
  longestGapFrames = Math.max(longestGapFrames, records.length - previousIndex - 1);

  const calibration: Partial<Record<DerivedAngle, PoseAngleRange>> = {};

  for (const angle of Object.keys(JOINT_BY_ANGLE) as DerivedAngle[]) {
    const sorted = angles.map((entry) => entry.values[angle]).sort((a, b) => a - b);
    const from: [number, number] = [percentile(sorted, FIT_LOW), percentile(sorted, FIT_HIGH)];

    const limit = limitFor(JOINT_BY_ANGLE[angle]);
    const travel = (limit.upper - limit.lower) * FIT_MARGIN;
    const centre = (limit.lower + limit.upper) / 2;
    const inSpan = Math.max(0, from[1] - from[0]);

    // `direct` aims for unit gain; `fit` fills the travel but is not allowed to
    // amplify jitter without bound. Neither may exceed the joint's travel.
    const outSpan = Math.min(travel, mapping === 'fit' ? inSpan * FIT_MAX_GAIN : inSpan);

    const low = centre - outSpan / 2;
    const high = centre + outSpan / 2;
    calibration[angle] = { from, to: INVERT[angle] ? [high, low] : [low, high] };
  }

  const toJoint = (angle: DerivedAngle, value: number): number => {
    const range = calibration[angle];
    if (!range) {
      return INVERT[angle] ? -value : value;
    }
    const [inLow, inHigh] = range.from;
    const [outLow, outHigh] = range.to;
    if (inHigh - inLow < 1e-9) return (outLow + outHigh) / 2;
    const t = (value - inLow) / (inHigh - inLow);
    return outLow + Math.min(1, Math.max(0, t)) * (outHigh - outLow);
  };

  const outputRecords = angles.map(({ index, values }) => {
    const source = records[index] as Record<string, unknown>;
    const timestamp = Number(source.timestamp ?? source.t ?? source.time);

    const record: Record<string, number | string> = { unit: 'rad' };
    if (Number.isFinite(timestamp)) record.timestamp = timestamp;

    for (const angle of Object.keys(JOINT_BY_ANGLE) as DerivedAngle[]) {
      record[JOINT_BY_ANGLE[angle]] = toJoint(angle, values[angle]);
    }
    return record;
  });

  return {
    records: outputRecords,
    side,
    mapping,
    totalFrames: records.length,
    detectedFrames,
    usableFrames: angles.length,
    longestGapFrames,
    tracking,
    calibration,
  };
}
