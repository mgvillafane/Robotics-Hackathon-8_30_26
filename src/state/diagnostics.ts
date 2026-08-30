export interface CollisionPair {
  a: string;
  b: string;
}

export interface DiagnosticsSnapshot {
  collisions: CollisionPair[];
  /** Joints clamped to a limit within the recency window. */
  clampedJoints: string[];
  /** Milliseconds spent in the last collision query. */
  checkCostMs: number;
  /** True while the guard is actively holding the arm at its last safe pose. */
  blocking: boolean;
  /** Cheap equality key so pollers can skip identical snapshots. */
  key: string;
}

const CLAMP_WINDOW_MS = 900;
const BLOCK_WINDOW_MS = 250;

/**
 * Collision and joint-limit findings, held outside React for the same reason
 * joint values are: they update per frame and only need to reach the UI a few
 * times a second.
 */
class Diagnostics {
  private collisionsBySlot = new Map<string, CollisionPair[]>();
  private clampedAt = new Map<string, number>();
  private checkCostMs = 0;
  private lastBlockedAt = 0;

  setCollisions(pairs: CollisionPair[], slot = 'left'): void {
    // Copy: callers reuse their array between frames.
    this.collisionsBySlot.set(
      slot,
      pairs.map((pair) => ({
        a: slot === 'left' ? pair.a : `${slot} ${pair.a}`,
        b: slot === 'left' ? pair.b : `${slot} ${pair.b}`,
      })),
    );
  }

  clearSlot(slot: string): void {
    this.collisionsBySlot.delete(slot);
  }

  getCollisions(): CollisionPair[] {
    return this.mergedCollisions();
  }

  private mergedCollisions(): CollisionPair[] {
    const merged: CollisionPair[] = [];
    for (const pairs of this.collisionsBySlot.values()) merged.push(...pairs);
    return merged;
  }

  markClamped(names: readonly string[]): void {
    if (names.length === 0) return;
    const now = performance.now();
    for (const name of names) this.clampedAt.set(name, now);
  }

  isClamped(name: string): boolean {
    const at = this.clampedAt.get(name);
    return at !== undefined && performance.now() - at < CLAMP_WINDOW_MS;
  }

  setCheckCost(ms: number): void {
    // Smoothed so the readout does not flicker.
    this.checkCostMs = this.checkCostMs * 0.9 + ms * 0.1;
  }

  noteBlocked(): void {
    this.lastBlockedAt = performance.now();
  }

  reset(): void {
    this.collisionsBySlot.clear();
    this.clampedAt.clear();
    this.checkCostMs = 0;
    this.lastBlockedAt = 0;
  }

  snapshot(): DiagnosticsSnapshot {
    const now = performance.now();
    const clampedJoints: string[] = [];
    for (const [name, at] of this.clampedAt) {
      if (now - at < CLAMP_WINDOW_MS) clampedJoints.push(name);
    }
    clampedJoints.sort();

    const collisions = this.mergedCollisions();
    const blocking = now - this.lastBlockedAt < BLOCK_WINDOW_MS;
    const key = [
      collisions.map((pair) => `${pair.a}~${pair.b}`).join(','),
      clampedJoints.join(','),
      blocking ? '1' : '0',
      this.checkCostMs.toFixed(1),
    ].join('|');

    return {
      collisions,
      clampedJoints,
      checkCostMs: this.checkCostMs,
      blocking,
      key,
    };
  }
}

export const diagnostics = new Diagnostics();
