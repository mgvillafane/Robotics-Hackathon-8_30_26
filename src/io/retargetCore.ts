import type { JointLimit } from './parse';

/**
 * Shared machinery for turning a motion capture into joint-state frames.
 *
 * Body-pose and hand captures differ only in which landmarks they read and what
 * those landmarks mean. Everything after that is common: dropouts interrupt the
 * signal, headings wrap, landmark noise needs damping, and the result has to
 * land inside a joint's travel. That work lives here so a new capture format is
 * an `extract` function and a list of signals.
 *
 * The pipeline runs in three passes, in this order for a reason:
 *
 * 1. Extract each frame's raw signals, unwrapping any that are headings. This
 *    has to be sequential and has to come first, because a percentile taken
 *    across a signal that jumps at +/-180 degrees is meaningless.
 * 2. Choose a mapping from the observed range onto the joint's travel.
 * 3. Damp and rate-limit, in the joint's own units. Doing this after the
 *    mapping rather than before is what makes the rate limit a real guarantee;
 *    smoothing first lets the mapping's gain amplify a step straight back past
 *    the limit.
 */

export type MappingMode = 'fit' | 'direct';

export interface SignalSpec {
  /** Key this signal appears under in an extracted sample. */
  key: string;
  /** URDF joint the signal drives. */
  joint: string;
  /** Set for headings that wrap at +/-180 degrees and need unwrapping. */
  wrapping?: boolean;
  /** Flip the direction of travel before it reaches the joint. */
  invert?: boolean;
  /**
   * A fixed input range that already carries meaning, such as a gripper opening
   * on 0..1. Set it to map that range straight onto the joint's travel, instead
   * of calibrating from what the capture happened to contain.
   */
  absolute?: [number, number];
}

export interface Sample {
  values: Record<string, number>;
  /**
   * Signals whose measurement cannot be trusted this frame. Their previous
   * value is carried forward rather than the frame being discarded, which
   * matters when one signal is degenerate but the rest are fine.
   */
  hold?: readonly string[];
}

export interface RetargetConfig {
  signals: SignalSpec[];
  /** Returns null when a frame cannot be used at all. */
  extract: (record: Record<string, unknown>, index: number) => Sample | null;
  limitFor: (joint: string) => JointLimit;
  mapping: MappingMode;
}

export interface SignalRange {
  /** Observed input window. */
  from: [number, number];
  /** Joint travel it maps onto. */
  to: [number, number];
}

export interface RetargetOutput {
  /** Joint-state records in radians, ready for the normal parser. */
  records: Array<Record<string, number | string>>;
  usableFrames: number;
  /** Longest run of consecutive unusable frames. */
  longestGapFrames: number;
  calibration: Record<string, SignalRange>;
}

/** Dropout length after which the signal restarts rather than easing across it. */
const GAP_RESET_FRAMES = 5;

/** Weight given to each new sample when damping landmark jitter. */
const SMOOTHING_ALPHA = 0.35;

/**
 * Ceiling on how fast a joint may be driven, in radians per second. Real arms
 * cannot slew arbitrarily fast, so capping this costs nothing in fidelity and
 * keeps a single bad landmark from becoming a lurch.
 */
const MAX_JOINT_RATE = 4.0;

/** Bounds on the inter-frame delta used for rate limiting, in seconds. */
const MIN_DT = 1 / 240;
const MAX_DT = 0.2;

/** Percentile window for calibration, trimming outliers from noisy landmarks. */
const FIT_LOW = 0.02;
const FIT_HIGH = 0.98;

/** Keeps output just inside the limits so it does not read as clamped. */
const FIT_MARGIN = 0.95;

/**
 * Ceiling on how much `fit` may stretch a signal. A subject who barely moved
 * produces a narrow, noisy range, and mapping that onto the full joint travel
 * would amplify jitter into violent motion.
 */
const FIT_MAX_GAIN = 1.5;

/** Shortest signed representation of an angle difference. */
export function wrapToPi(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function limitStep(previous: number, target: number, maxDelta: number): number {
  const delta = target - previous;
  return previous + Math.max(-maxDelta, Math.min(maxDelta, delta));
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Seconds, from whichever time field the producer used. */
export function readTime(record: Record<string, unknown>): number | null {
  const time = Number(record.timestamp ?? record.t ?? record.time);
  return Number.isFinite(time) ? time : null;
}

export function runRetarget(records: unknown[], config: RetargetConfig): RetargetOutput {
  const { signals, extract, limitFor, mapping } = config;

  // --- pass 1: extract, and unwrap headings into a continuous signal --------

  interface Frame {
    index: number;
    time: number | null;
    values: Record<string, number>;
  }

  const frames: Frame[] = [];
  let previousValues: Record<string, number> | null = null;
  let lastIndex = -1;

  records.forEach((record, index) => {
    if (!isRecord(record)) return;
    const sample = extract(record, index);
    if (!sample) return;

    const fresh = previousValues === null || index - lastIndex > GAP_RESET_FRAMES;
    const values: Record<string, number> = {};

    for (const signal of signals) {
      const raw = sample.values[signal.key];
      const held = sample.hold?.includes(signal.key) ?? false;

      if (fresh || previousValues === null) {
        // Nothing trustworthy to carry forward, so take the reading as it is.
        values[signal.key] = raw;
        continue;
      }

      const previous = previousValues[signal.key];

      if (held || !Number.isFinite(raw)) {
        values[signal.key] = previous;
      } else if (signal.wrapping) {
        // Accumulate along the shortest arc and deliberately do not re-wrap:
        // an unwrapped heading is what keeps the seam from reading as a sweep
        // across the joint's whole travel.
        values[signal.key] = previous + wrapToPi(raw - previous);
      } else {
        values[signal.key] = raw;
      }
    }

    previousValues = values;
    lastIndex = index;
    frames.push({ index, time: readTime(record), values });
  });

  let longestGapFrames = 0;
  let previousIndex = -1;
  for (const frame of frames) {
    longestGapFrames = Math.max(longestGapFrames, frame.index - previousIndex - 1);
    previousIndex = frame.index;
  }
  longestGapFrames = Math.max(longestGapFrames, records.length - previousIndex - 1);

  // --- pass 2: decide how each signal maps onto its joint ------------------

  const calibration: Record<string, SignalRange> = {};

  for (const signal of signals) {
    const limit = limitFor(signal.joint);
    const travel = (limit.upper - limit.lower) * FIT_MARGIN;
    const centre = (limit.lower + limit.upper) / 2;

    if (signal.absolute) {
      // The input means something on its own, so it keeps its endpoints and
      // simply spans the joint's travel.
      const low = centre - travel / 2;
      const high = centre + travel / 2;
      calibration[signal.key] = {
        from: signal.absolute,
        to: signal.invert ? [high, low] : [low, high],
      };
      continue;
    }

    const sorted = frames.map((frame) => frame.values[signal.key]).sort((a, b) => a - b);
    const from: [number, number] = [percentile(sorted, FIT_LOW), percentile(sorted, FIT_HIGH)];
    const inSpan = Math.max(0, from[1] - from[0]);
    const outSpan = Math.min(travel, mapping === 'fit' ? inSpan * FIT_MAX_GAIN : inSpan);

    const low = centre - outSpan / 2;
    const high = centre + outSpan / 2;
    calibration[signal.key] = { from, to: signal.invert ? [high, low] : [low, high] };
  }

  const toJoint = (key: string, value: number): number => {
    const range = calibration[key];
    const [inLow, inHigh] = range.from;
    const [outLow, outHigh] = range.to;
    if (inHigh - inLow < 1e-9) return (outLow + outHigh) / 2;
    const t = (value - inLow) / (inHigh - inLow);
    return outLow + Math.min(1, Math.max(0, t)) * (outHigh - outLow);
  };

  // --- pass 3: damp and rate-limit, now in the joint's own units -----------

  const outputRecords: Array<Record<string, number | string>> = [];
  let previousJoints: Record<string, number> | null = null;
  let lastTime: number | null = null;
  lastIndex = -1;

  for (const frame of frames) {
    const target: Record<string, number> = {};
    for (const signal of signals) {
      target[signal.joint] = toJoint(signal.key, frame.values[signal.key]);
    }

    let next: Record<string, number>;

    if (previousJoints === null || frame.index - lastIndex > GAP_RESET_FRAMES) {
      next = target;
    } else {
      const dt =
        frame.time !== null && lastTime !== null
          ? Math.min(MAX_DT, Math.max(MIN_DT, frame.time - lastTime))
          : Math.min(MAX_DT, Math.max(MIN_DT, (frame.index - lastIndex) / 30));
      const maxDelta = MAX_JOINT_RATE * dt;

      next = {};
      for (const signal of signals) {
        const previous = previousJoints[signal.joint];
        const eased = previous + SMOOTHING_ALPHA * (target[signal.joint] - previous);
        next[signal.joint] = limitStep(previous, eased, maxDelta);
      }
    }

    const record: Record<string, number | string> = { unit: 'rad', ...next };
    if (frame.time !== null) record.timestamp = frame.time;
    outputRecords.push(record);

    previousJoints = next;
    lastIndex = frame.index;
    if (frame.time !== null) lastTime = frame.time;
  }

  return {
    records: outputRecords,
    usableFrames: frames.length,
    longestGapFrames,
    calibration,
  };
}
