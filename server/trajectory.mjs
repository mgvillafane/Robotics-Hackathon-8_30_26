/**
 * A smooth, looping demo motion for SO-101-shaped arms.
 *
 * Shared by the demo publisher and the sample trajectory generator so both
 * produce the same movement. All values are radians and stay well inside the
 * arm's travel limits.
 */

export const JOINT_NAMES = [
  'shoulder_pan',
  'shoulder_lift',
  'elbow_flex',
  'wrist_flex',
  'wrist_roll',
  'gripper',
];

/** Joint positions at time `t` (seconds), as a name-to-radians object. */
export function poseAt(t) {
  return {
    shoulder_pan: 0.85 * Math.sin(0.45 * t),
    shoulder_lift: -0.45 + 0.5 * Math.sin(0.7 * t),
    elbow_flex: 0.75 * Math.sin(0.6 * t + 1.0),
    wrist_flex: 0.55 * Math.sin(0.9 * t + 0.4),
    wrist_roll: 1.15 * Math.sin(0.35 * t),
    gripper: 0.55 + 0.5 * Math.sin(1.4 * t),
  };
}

/** Duration after which the motion repeats closely enough to loop, in seconds. */
export const LOOP_SECONDS = 30;
