import { useEffect, useState } from 'react';
import { displayedJoints, targetJoints } from '../state/jointBus';

type Bus = typeof targetJoints;

/**
 * Samples a joint bus on a timer instead of subscribing to it.
 *
 * Streams can deliver frames far faster than the UI needs to redraw, so the
 * readouts poll at a fixed rate and skip renders when nothing changed.
 */
export function useJointSnapshot(bus: Bus, hz = 20): Record<string, number> {
  const [snapshot, setSnapshot] = useState<Record<string, number>>(() => bus.snapshot());

  useEffect(() => {
    const intervalMs = 1000 / hz;
    let frameId = 0;
    let lastSampledAt = 0;
    let lastRevision = -1;

    const tick = (time: number) => {
      frameId = requestAnimationFrame(tick);
      if (time - lastSampledAt < intervalMs) return;
      lastSampledAt = time;

      const revision = bus.getRevision();
      if (revision === lastRevision) return;
      lastRevision = revision;
      setSnapshot(bus.snapshot());
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [bus, hz]);

  return snapshot;
}

/** Frames per second currently arriving from the active source. */
export function useStreamRate(hz = 4): number {
  const [rate, setRate] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setRate(targetJoints.getFrameRate()), 1000 / hz);
    return () => window.clearInterval(id);
  }, [hz]);

  return rate;
}

export { displayedJoints, targetJoints };
