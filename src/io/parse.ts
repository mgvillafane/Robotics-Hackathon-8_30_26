import type { AngleUnit, JointDefinition, RobotDefinition } from '../robots/types';

const DEG = Math.PI / 180;

export interface JointLimit {
  lower: number;
  upper: number;
}

export type JointLimits = Record<string, JointLimit>;

export interface ParsedFrame {
  /** URDF joint name mapped to a position in radians. */
  positions: Record<string, number>;
  sentAt?: number;
  robotId?: string;
  /** Payload keys that matched no joint, surfaced in the UI to catch typos. */
  unmatchedKeys: string[];
  /** Joints whose commanded value fell outside the limits and was clamped. */
  clamped: string[];
}

export class JointStateParseError extends Error {}

/** Limits from the definition, overridden by anything parsed out of the URDF. */
export function resolveLimits(robot: RobotDefinition, fromUrdf?: JointLimits): JointLimits {
  const limits: JointLimits = {};
  for (const joint of robot.joints) {
    const urdfLimit = fromUrdf?.[joint.urdfName];
    limits[joint.urdfName] =
      urdfLimit && urdfLimit.upper > urdfLimit.lower
        ? urdfLimit
        : { lower: joint.lower, upper: joint.upper };
  }
  return limits;
}

function toRadians(
  value: number,
  unit: AngleUnit,
  joint: JointDefinition,
  limit: JointLimit,
): number {
  let radians: number;

  if (unit === 'norm100') {
    const [low, high] = joint.normalizedRange ?? [-100, 100];
    let t = high === low ? 0 : (value - low) / (high - low);
    if (joint.invert) t = 1 - t;
    radians = limit.lower + t * (limit.upper - limit.lower);
  } else {
    radians = unit === 'deg' ? value * DEG : value;
    if (joint.invert) radians = -radians;
  }

  return radians + (joint.offset ?? 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.map((entry) => Number(entry));
  return numbers.every((entry) => Number.isFinite(entry)) ? numbers : undefined;
}

/**
 * Pull a joint-name-to-number map out of the many shapes a producer might send.
 * Recognised layouts, in priority order:
 *
 *   [0.1, 0.2, ...]                              ordered by the definition
 *   { positions: {...} | [...] }                 native format
 *   { name: [...], position: [...] }             ROS sensor_msgs/JointState
 *   { "observation.state": [...] } or { action } LeRobot feature keys
 *   { shoulder_pan: 0.1, ... }                   bare joint map
 */
function extractRawValues(
  payload: unknown,
  robot: RobotDefinition,
): { values: Record<string, number>; unmatchedKeys: string[] } {
  const byStreamKey = new Map(robot.joints.map((joint) => [joint.streamKey, joint]));
  const values: Record<string, number> = {};
  const unmatchedKeys: string[] = [];

  const fromArray = (numbers: number[]) => {
    if (numbers.length > robot.joints.length) {
      unmatchedKeys.push(
        `array of ${numbers.length} values, expected ${robot.joints.length}`,
      );
    }
    numbers.slice(0, robot.joints.length).forEach((value, index) => {
      values[robot.joints[index].streamKey] = value;
    });
  };

  const ordered = toNumberArray(payload);
  if (ordered) {
    fromArray(ordered);
    return { values, unmatchedKeys };
  }

  if (!isRecord(payload)) {
    throw new JointStateParseError('Joint state payload must be an object or an array.');
  }

  // ROS sensor_msgs/JointState
  const names = payload.name;
  const positionArray = toNumberArray(payload.position);
  if (Array.isArray(names) && positionArray) {
    names.forEach((name, index) => {
      if (typeof name === 'string' && index < positionArray.length) {
        values[name] = positionArray[index];
      }
    });
    return { values, unmatchedKeys };
  }

  const container =
    payload.positions ?? payload.joint_states ?? payload['observation.state'] ?? payload.action;

  if (container !== undefined) {
    const containerArray = toNumberArray(container);
    if (containerArray) {
      fromArray(containerArray);
      return { values, unmatchedKeys };
    }
    if (isRecord(container)) {
      for (const [key, value] of Object.entries(container)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) values[key] = numeric;
        else unmatchedKeys.push(key);
      }
      return { values, unmatchedKeys };
    }
    throw new JointStateParseError('`positions` must be an array or an object.');
  }

  // Bare joint map: ignore known metadata fields.
  const metadata = new Set(['unit', 'units', 'timestamp', 't', 'time', 'robot', 'robot_id', 'seq']);
  for (const [key, value] of Object.entries(payload)) {
    if (metadata.has(key)) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) values[key] = numeric;
    else unmatchedKeys.push(key);
  }

  if (Object.keys(values).length === 0 && unmatchedKeys.length === 0) {
    throw new JointStateParseError('Payload contained no numeric joint values.');
  }

  // Reject keys that match nothing on this robot so the UI can warn.
  for (const key of Object.keys(values)) {
    if (!byStreamKey.has(key) && !robot.joints.some((joint) => joint.urdfName === key)) {
      unmatchedKeys.push(key);
    }
  }

  return { values, unmatchedKeys };
}

function readUnit(payload: unknown, fallback: AngleUnit): AngleUnit {
  if (!isRecord(payload)) return fallback;
  const raw = payload.unit ?? payload.units;
  if (raw === 'rad' || raw === 'radians') return 'rad';
  if (raw === 'deg' || raw === 'degrees') return 'deg';
  if (raw === 'norm100' || raw === 'normalized') return 'norm100';
  return fallback;
}

export interface ParseOptions {
  /** Clamp incoming positions into the joint's travel. Defaults to true. */
  clamp?: boolean;
  /** Limits to clamp and de-normalise against, usually taken from the URDF. */
  limits?: JointLimits;
}

export function parseJointStatePayload(
  raw: unknown,
  robot: RobotDefinition,
  options: ParseOptions = {},
): ParsedFrame {
  let payload = raw;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw new JointStateParseError('Payload was not valid JSON.');
    }
  }

  const { values, unmatchedKeys } = extractRawValues(payload, robot);
  const unit = readUnit(payload, robot.streamUnit);
  const limits = options.limits ?? resolveLimits(robot);
  const clamp = options.clamp ?? true;

  const positions: Record<string, number> = {};
  const clamped: string[] = [];

  for (const joint of robot.joints) {
    const value = values[joint.streamKey] ?? values[joint.urdfName];
    if (value === undefined || !Number.isFinite(value)) continue;

    const limit = limits[joint.urdfName] ?? { lower: joint.lower, upper: joint.upper };
    // A joint may read the frame's unit differently to the rest of the robot.
    const jointUnit = joint.unitAliases?.[unit] ?? unit;
    let radians = toRadians(value, jointUnit, joint, limit);

    if (clamp) {
      const limited = Math.min(limit.upper, Math.max(limit.lower, radians));
      if (limited !== radians) clamped.push(joint.urdfName);
      radians = limited;
    }

    positions[joint.urdfName] = radians;
  }

  const frame: ParsedFrame = { positions, unmatchedKeys, clamped };

  if (isRecord(payload)) {
    const sentAt = Number(payload.timestamp ?? payload.t ?? payload.time);
    if (Number.isFinite(sentAt)) {
      // Accept seconds or milliseconds; anything below this threshold is
      // implausible as an epoch in milliseconds.
      frame.sentAt = sentAt < 1e11 ? sentAt * 1000 : sentAt;
    }
    const robotId = payload.robot ?? payload.robot_id;
    if (typeof robotId === 'string') frame.robotId = robotId;
  }

  return frame;
}
