import { useEffect, useState } from 'react';
import { diagnostics, type DiagnosticsSnapshot } from '../state/diagnostics';

/**
 * Samples collision and joint-limit findings on a timer.
 *
 * Detection runs every rendered frame; the UI only needs it a few times a
 * second, and the snapshot's key lets identical polls skip the re-render.
 */
export function useDiagnostics(hz = 10): DiagnosticsSnapshot {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot>(() => diagnostics.snapshot());

  useEffect(() => {
    const id = window.setInterval(() => {
      setSnapshot((previous) => {
        const next = diagnostics.snapshot();
        return next.key === previous.key ? previous : next;
      });
    }, 1000 / hz);
    return () => window.clearInterval(id);
  }, [hz]);

  return snapshot;
}
