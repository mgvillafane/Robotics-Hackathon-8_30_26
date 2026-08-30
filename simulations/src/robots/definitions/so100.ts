import type { RobotDefinition } from '../types';
import { so101 } from './so101';

/**
 * SO-100, the predecessor to the SO-101. Same kinematic layout and joint names,
 * different link geometry, so it reuses the SO-101 joint table with its own
 * URDF. Included mainly to exercise the multi-arm path.
 *
 * Its fallback limits are inherited from the SO-101 and are approximate; the
 * real values are read from the URDF once it is installed.
 */
export const so100: RobotDefinition = {
  ...so101,
  id: 'so100',
  name: 'SO-100 Follower',
  description: 'Previous-generation 5-DOF arm. Shares the SO-101 joint naming.',
  urdfUrl: '/robots/so100/so100.urdf',
  assets: {
    sourceUrl: 'https://github.com/TheRobotStudio/SO-ARM100/tree/main/Simulation/SO100',
    license: 'Apache-2.0',
    instructions: [
      'Copy Simulation/SO100/so100.urdf from TheRobotStudio/SO-ARM100 into public/robots/so100/.',
      'Copy its accompanying assets/ mesh folder into public/robots/so100/assets/.',
    ],
  },
};
