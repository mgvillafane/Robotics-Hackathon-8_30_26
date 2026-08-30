import type { RobotDefinition } from './types';
import { so101 } from './definitions/so101';
import { so100 } from './definitions/so100';

const robots = new Map<string, RobotDefinition>();

export function registerRobot(definition: RobotDefinition): void {
  const seen = new Set<string>();
  for (const joint of definition.joints) {
    if (seen.has(joint.streamKey)) {
      throw new Error(
        `Robot "${definition.id}" reuses stream key "${joint.streamKey}"; keys must be unique.`,
      );
    }
    seen.add(joint.streamKey);
  }
  robots.set(definition.id, definition);
}

export function getRobot(id: string): RobotDefinition | undefined {
  return robots.get(id);
}

export function listRobots(): RobotDefinition[] {
  return [...robots.values()];
}

for (const definition of [so101, so100]) {
  registerRobot(definition);
}

export const DEFAULT_ROBOT_ID = so101.id;
