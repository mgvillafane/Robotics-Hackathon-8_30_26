/**
 * Holds the newest joint positions outside of React.
 *
 * Incoming streams can run at 100 Hz or more. Routing them through React state
 * would re-render the tree on every frame, so the renderer reads this object
 * directly inside its animation loop and the UI polls it at a lower rate.
 */
export class JointBus {
  private positions: Record<string, number> = {};
  private revision = 0;
  private recentFrameTimes: number[] = [];

  /** Merge a frame of positions, in radians, keyed by URDF joint name. */
  apply(positions: Record<string, number>): void {
    let changed = false;
    for (const [name, value] of Object.entries(positions)) {
      if (this.positions[name] !== value) {
        this.positions[name] = value;
        changed = true;
      }
    }
    this.markFrame();
    if (changed) this.revision += 1;
  }

  set(name: string, value: number): void {
    if (this.positions[name] === value) return;
    this.positions[name] = value;
    this.revision += 1;
    this.markFrame();
  }

  get(name: string): number {
    return this.positions[name] ?? 0;
  }

  snapshot(): Record<string, number> {
    return { ...this.positions };
  }

  /** Increments whenever a value actually changes; used to skip UI updates. */
  getRevision(): number {
    return this.revision;
  }

  /** Replace all values, dropping joints that belong to another robot. */
  reset(positions: Record<string, number> = {}): void {
    this.positions = { ...positions };
    this.revision += 1;
    this.recentFrameTimes = [];
  }

  /** Frames received in the last second. */
  getFrameRate(): number {
    const cutoff = performance.now() - 1000;
    while (this.recentFrameTimes.length > 0 && this.recentFrameTimes[0] < cutoff) {
      this.recentFrameTimes.shift();
    }
    return this.recentFrameTimes.length;
  }

  private markFrame(): void {
    this.recentFrameTimes.push(performance.now());
    if (this.recentFrameTimes.length > 240) this.recentFrameTimes.shift();
  }
}

export type ArmSlot = 'left' | 'right';

export interface ArmBuses {
  target: JointBus;
  displayed: JointBus;
}

function createArmBuses(): ArmBuses {
  return { target: new JointBus(), displayed: new JointBus() };
}

/**
 * One bus pair per arm in the scene. A single-arm session only writes `left`;
 * dual-arm playback writes left and right independently so the two models
 * cannot overwrite each other.
 */
export const armBuses: Record<ArmSlot, ArmBuses> = {
  left: createArmBuses(),
  right: createArmBuses(),
};

/** Positions requested by the input source. Alias for the left (primary) arm. */
export const targetJoints = armBuses.left.target;

/**
 * Positions actually rendered. Equal to `targetJoints` unless smoothing is on,
 * in which case the renderer eases these toward the target each frame.
 */
export const displayedJoints = armBuses.left.displayed;

export function resetArmBuses(): void {
  armBuses.left.target.reset();
  armBuses.left.displayed.reset();
  armBuses.right.target.reset();
  armBuses.right.displayed.reset();
}
