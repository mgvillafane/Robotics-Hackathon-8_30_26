/**
 * Holds the newest joint positions outside of React.
 *
 * Incoming streams can run at 100 Hz or more. Routing them through React state
 * would re-render the tree on every frame, so the renderer reads this object
 * directly inside its animation loop and the UI polls it at a lower rate.
 */
class JointBus {
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

/** Positions requested by the input source. */
export const targetJoints = new JointBus();

/**
 * Positions actually rendered. Equal to `targetJoints` unless smoothing is on,
 * in which case the renderer eases these toward the target each frame.
 */
export const displayedJoints = new JointBus();
