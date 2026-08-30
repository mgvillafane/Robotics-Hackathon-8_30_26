import { useEffect, useRef } from 'react';
import type { RobotDefinition } from '../robots/types';
import { WebSocketSource } from '../io/websocketSource';
import { targetJoints } from '../state/jointBus';
import { diagnostics } from '../state/diagnostics';
import { useSimulatorStore } from '../state/store';

/**
 * Runs the WebSocket source while that input mode is selected.
 *
 * Manual control writes to the joint bus straight from the sliders, and
 * playback owns its own source instance, so neither is handled here.
 */
export function useJointStream(definition: RobotDefinition): void {
  const sourceKind = useSimulatorStore((state) => state.sourceKind);
  const websocketUrl = useSimulatorStore((state) => state.websocketUrl);
  const setStatus = useSimulatorStore((state) => state.setStatus);
  const pushLog = useSimulatorStore((state) => state.pushLog);

  // Read through a ref so limits refined by the URDF apply without a reconnect.
  const limitsRef = useRef(useSimulatorStore.getState().limits);
  useEffect(
    () => useSimulatorStore.subscribe((state) => (limitsRef.current = state.limits)),
    [],
  );

  useEffect(() => {
    if (sourceKind !== 'websocket') return;

    const source = new WebSocketSource({
      url: websocketUrl,
      robot: definition,
      getLimits: () => limitsRef.current,
      onParseError: (message) => pushLog('warn', message),
    });

    source.start({
      onFrame: (frame) => {
        targetJoints.apply(frame.positions);
        if (frame.clamped?.length) diagnostics.markClamped(frame.clamped);
      },
      onStatus: (status, detail) => {
        setStatus(status, detail);
        if (status === 'error') pushLog('error', detail ?? 'Stream error');
        if (status === 'connected') pushLog('info', `Connected to ${websocketUrl}`);
      },
    });

    return () => source.stop();
  }, [sourceKind, websocketUrl, definition, setStatus, pushLog]);
}
