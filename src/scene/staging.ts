import type { ArmSlot } from '../state/jointBus';

/**
 * Dual-arm staging, like a person's shoulders.
 *
 * The SO-101 reaches along URDF +X, which is world +X after the Z-up correction.
 * The shoulder line is world X; both arms yaw so they reach toward +Z (the camera).
 * Positions are mirrored relative to the camera: the subject's right arm sits
 * on the viewer's left, the way a person facing you does.
 */
export const DUAL_OFFSET = 0.22;
export const DUAL_YAW = -Math.PI / 2;
export const DUAL_TOE_IN = 0.22;
export const DUAL_CAMERA = {
  position: [0, 0.42, 0.92] as [number, number, number],
  target: [0, 0.1, 0.08] as [number, number, number],
};

export function armPose(slot: ArmSlot, dualArm: boolean): {
  offset: [number, number, number];
  yaw: number;
} {
  if (!dualArm) return { offset: [0, 0, 0], yaw: 0 };
  if (slot === 'left') {
    return { offset: [DUAL_OFFSET, 0, 0], yaw: DUAL_YAW - DUAL_TOE_IN };
  }
  return { offset: [-DUAL_OFFSET, 0, 0], yaw: DUAL_YAW + DUAL_TOE_IN };
}

/** URDF Z-up → scene Y-up, matching the robot group's −90° X rotation. */
export function urdfToWorld(point: { x: number; y: number; z: number }): [number, number, number] {
  return [point.x, point.z, -point.y];
}

/**
 * Places a URDF-frame point into world space in front of the given arm,
 * using the same offset and yaw as the robot itself.
 */
/** How far the bases may slide toward the capture cloud, in metres. */
export const APPROACH_RANGE = { min: 0, max: 0.1, step: 0.005 } as const;

/**
 * World-space translation that slides a robot along its reach axis (URDF +X)
 * toward the workspace, after the same yaw used on stage.
 */
export function approachWorldDelta(yaw: number, approach: number): [number, number, number] {
  const [x, y, z] = urdfToWorld({ x: approach, y: 0, z: 0 });
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [c * x + s * z, y, -s * x + c * z];
}

export function addOffset(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function placeUrdfPoint(
  point: { x: number; y: number; z: number },
  slot: ArmSlot,
  dualArm: boolean,
  approach = 0,
): [number, number, number] {
  const [x, y, z] = urdfToWorld(point);
  const pose = armPose(slot, dualArm);
  const offset = addOffset(pose.offset, approachWorldDelta(pose.yaw, approach));
  const c = Math.cos(pose.yaw);
  const s = Math.sin(pose.yaw);
  return [offset[0] + c * x + s * z, offset[1] + y, offset[2] - s * x + c * z];
}
