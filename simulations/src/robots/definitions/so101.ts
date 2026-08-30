import type { RobotDefinition } from '../types';

/**
 * LeRobot SO-101 follower: 5 revolute joints plus a gripper.
 *
 * Limits match `so101_new_calib.urdf` from TheRobotStudio/SO-ARM100. They are
 * fallbacks only: once the URDF loads, its own limits replace them, so a
 * mismatch with your calibration file is self-correcting.
 */
export const so101: RobotDefinition = {
  id: 'so101',
  name: 'SO-101 Follower',
  vendor: 'TheRobotStudio / LeRobot',
  description: '5-DOF low-cost arm with parallel gripper, used by LeRobot.',
  urdfUrl: '/robots/so101/so101_new_calib.urdf',
  // LeRobot has defaulted `use_degrees` to true since v0.6.0, so a frame that
  // omits its unit is most likely degrees. Producers should still send `unit`
  // explicitly; this only decides what an unlabelled frame means.
  streamUnit: 'deg',
  upAxis: 'Z',
  scale: 1,
  camera: {
    position: [0.45, 0.35, 0.45],
    target: [0, 0.12, 0],
  },
  joints: [
    {
      urdfName: 'shoulder_pan',
      streamKey: 'shoulder_pan',
      label: 'Shoulder Pan',
      lower: -1.91986,
      upper: 1.91986,
    },
    {
      urdfName: 'shoulder_lift',
      streamKey: 'shoulder_lift',
      label: 'Shoulder Lift',
      lower: -1.74533,
      upper: 1.74533,
    },
    {
      urdfName: 'elbow_flex',
      streamKey: 'elbow_flex',
      label: 'Elbow Flex',
      lower: -1.69,
      upper: 1.69,
    },
    {
      urdfName: 'wrist_flex',
      streamKey: 'wrist_flex',
      label: 'Wrist Flex',
      lower: -1.65806,
      upper: 1.65806,
    },
    {
      urdfName: 'wrist_roll',
      streamKey: 'wrist_roll',
      label: 'Wrist Roll',
      lower: -2.74385,
      upper: 2.84121,
    },
    {
      urdfName: 'gripper',
      streamKey: 'gripper',
      label: 'Gripper',
      lower: -0.174533,
      upper: 1.74533,
      // The gripper is hardcoded to RANGE_0_100 in LeRobot and is never in
      // degrees, so a degrees frame still carries 0 (closed) to 100 (open).
      normalizedRange: [0, 100],
      unitAliases: { deg: 'norm100' },
    },
  ],
  // Approximate SO-101 proportions, in metres.
  placeholder: [
    { joint: 'shoulder_pan', axis: 'y', length: 0.055, radius: 0.028 },
    { joint: 'shoulder_lift', axis: 'x', length: 0.115, radius: 0.021 },
    { joint: 'elbow_flex', axis: 'x', length: 0.11, radius: 0.018 },
    { joint: 'wrist_flex', axis: 'x', length: 0.05, radius: 0.016 },
    { joint: 'wrist_roll', axis: 'y', length: 0.035, radius: 0.014 },
    { joint: 'gripper', axis: 'x', length: 0.05, radius: 0.012, gripper: true },
  ],
  assets: {
    sourceUrl: 'https://github.com/TheRobotStudio/SO-ARM100/tree/main/Simulation/SO101',
    license: 'Apache-2.0',
    instructions: [
      'Copy Simulation/SO101/so101_new_calib.urdf from TheRobotStudio/SO-ARM100 into public/robots/so101/.',
      'Copy the whole Simulation/SO101/assets/ folder (13 STL files, ~16 MB) into public/robots/so101/assets/.',
      'The URDF references meshes as assets/<name>.stl relative to itself, so no further configuration is needed.',
      'Use so101_new_calib.urdf, not so101_old_calib.urdf \u2014 the old file zeroes at a different pose and has different limits.',
    ],
  },
};
