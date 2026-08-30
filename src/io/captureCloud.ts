import { isHandCapture } from './handRetarget';
import { isPoseCapture, type ArmSide } from './poseRetarget';
import {
  landmarkToWorkspace,
  percentileRange,
  type Vec3,
  type WorkspaceBox,
} from './so101Ik';

export interface CloudPoint {
  x: number;
  y: number;
  z: number;
  side: ArmSide;
  name: string;
  frame: number;
  time: number | null;
}

export interface CaptureCloud {
  kind: 'hand' | 'pose';
  points: CloudPoint[];
  minTime: number | null;
  maxTime: number | null;
  maxFrame: number;
}

const HAND_LANDMARKS = ['wrist', 'thumb', 'index', 'index_mcp', 'middle_mcp', 'middle_tip'] as const;
const POSE_LANDMARKS: Array<{ name: string; side: ArmSide }> = [
  { name: 'left_shoulder', side: 'left' },
  { name: 'left_elbow', side: 'left' },
  { name: 'left_wrist', side: 'left' },
  { name: 'left_hip', side: 'left' },
  { name: 'right_shoulder', side: 'right' },
  { name: 'right_elbow', side: 'right' },
  { name: 'right_wrist', side: 'right' },
  { name: 'right_hip', side: 'right' },
];

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
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, z: Number.isFinite(z) ? z : 0 };
}

function parseSide(value: unknown): ArmSide | null {
  const label = String(value ?? '').trim().toLowerCase();
  if (label === 'left' || label === 'right') return label;
  return null;
}

function truthyDetected(value: unknown): boolean {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

function recordTime(record: Record<string, unknown>): number | null {
  const time = Number(record.timestamp ?? record.t ?? record.time);
  return Number.isFinite(time) ? time : null;
}

interface RawSample {
  side: ArmSide;
  name: string;
  landmark: Vec3;
  frame: number;
  time: number | null;
}

function collectHand(records: unknown[]): RawSample[] {
  const samples: RawSample[] = [];
  records.forEach((record, frame) => {
    if (!isRecord(record)) return;
    const time = recordTime(record);

    const primarySide = parseSide(record.hand_label);
    if (primarySide && truthyDetected(record.hand_detected)) {
      for (const name of HAND_LANDMARKS) {
        const landmark = point(record, name);
        if (landmark) samples.push({ side: primarySide, name, landmark, frame, time });
      }
    }

    const otherSide = parseSide(record.other_hand_label);
    if (otherSide && point(record, 'other_wrist')) {
      for (const name of HAND_LANDMARKS) {
        const landmark = point(record, `other_${name}`);
        if (landmark) samples.push({ side: otherSide, name, landmark, frame, time });
      }
    }
  });
  return samples;
}

function collectPose(records: unknown[]): RawSample[] {
  const samples: RawSample[] = [];
  records.forEach((record, frame) => {
    if (!isRecord(record)) return;
    const time = recordTime(record);
    for (const { name, side } of POSE_LANDMARKS) {
      const landmark = point(record, name);
      if (landmark) samples.push({ side, name, landmark, frame, time });
    }
  });
  return samples;
}

function mapSide(samples: RawSample[], side: ArmSide, workspace?: WorkspaceBox): CloudPoint[] {
  const ofSide = samples.filter((sample) => sample.side === side);
  if (ofSide.length === 0) return [];
  const observed = {
    x: percentileRange(ofSide.map((sample) => sample.landmark.x)),
    y: percentileRange(ofSide.map((sample) => sample.landmark.y)),
    z: percentileRange(ofSide.map((sample) => sample.landmark.z)),
  };
  return ofSide.map((sample) => {
    const mapped = landmarkToWorkspace(sample.landmark, observed, workspace);
    return {
      x: mapped.x,
      y: mapped.y,
      z: mapped.z,
      side,
      name: sample.name,
      frame: sample.frame,
      time: sample.time,
    };
  });
}

/**
 * Turns an uploaded pose or hand table into workspace points the scene can
 * plot. Each side is fitted independently into the same box the IK solver uses,
 * so the cloud sits where the arms reach.
 */
export function buildCaptureCloud(
  records: unknown[],
  options: { workspace?: WorkspaceBox } = {},
): CaptureCloud | null {
  const kind = isHandCapture(records) ? 'hand' : isPoseCapture(records) ? 'pose' : null;
  if (!kind) return null;

  const raw = kind === 'hand' ? collectHand(records) : collectPose(records);
  if (raw.length === 0) return null;

  const points = [
    ...mapSide(raw, 'left', options.workspace),
    ...mapSide(raw, 'right', options.workspace),
  ];
  const times = points.map((point) => point.time).filter((time): time is number => time !== null);
  return {
    kind,
    points,
    minTime: times.length > 0 ? Math.min(...times) : null,
    maxTime: times.length > 0 ? Math.max(...times) : null,
    maxFrame: points.reduce((max, point) => Math.max(max, point.frame), 0),
  };
}

export function cloudTimeAtProgress(cloud: CaptureCloud, progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  if (cloud.minTime !== null && cloud.maxTime !== null && cloud.maxTime > cloud.minTime) {
    return cloud.minTime + t * (cloud.maxTime - cloud.minTime);
  }
  return t * cloud.maxFrame;
}

export function cloudKey(point: Pick<CloudPoint, 'frame' | 'time'>): number {
  return point.time ?? point.frame;
}
