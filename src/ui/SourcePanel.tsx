import { useEffect, useState, type FormEvent } from 'react';
import type { SourceKind } from '../io/types';
import { useSimulatorStore } from '../state/store';
import { PlaybackPanel } from './PlaybackPanel';
import type { RobotDefinition } from '../robots/types';

const MODES: Array<{ kind: SourceKind; label: string; hint: string }> = [
  { kind: 'manual', label: 'Manual', hint: 'Drag the joint sliders.' },
  { kind: 'websocket', label: 'WebSocket', hint: 'Stream joint states from a live producer.' },
  { kind: 'playback', label: 'Playback', hint: 'Replay a recorded trajectory file.' },
];

export function SourcePanel({ definition }: { definition: RobotDefinition }) {
  const sourceKind = useSimulatorStore((state) => state.sourceKind);
  const setSourceKind = useSimulatorStore((state) => state.setSourceKind);
  const websocketUrl = useSimulatorStore((state) => state.websocketUrl);
  const setWebsocketUrl = useSimulatorStore((state) => state.setWebsocketUrl);
  const status = useSimulatorStore((state) => state.status);

  const [draftUrl, setDraftUrl] = useState(websocketUrl);
  useEffect(() => setDraftUrl(websocketUrl), [websocketUrl]);

  const activeMode = MODES.find((mode) => mode.kind === sourceKind);

  const applyUrl = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draftUrl.trim();
    if (trimmed.length > 0) setWebsocketUrl(trimmed);
  };

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Input source</h2>
      </header>

      <div className="segmented" role="tablist" aria-label="Joint state source">
        {MODES.map((mode) => (
          <button
            key={mode.kind}
            type="button"
            role="tab"
            aria-selected={sourceKind === mode.kind}
            className={`segmented__item ${sourceKind === mode.kind ? 'is-active' : ''}`}
            onClick={() => setSourceKind(mode.kind)}
          >
            {mode.label}
          </button>
        ))}
      </div>

      {activeMode && <p className="panel__hint">{activeMode.hint}</p>}

      {sourceKind === 'websocket' && (
        <form className="field" onSubmit={applyUrl}>
          <label htmlFor="ws-url">Endpoint</label>
          <div className="field__row">
            <input
              id="ws-url"
              className="input"
              value={draftUrl}
              spellCheck={false}
              onChange={(event) => setDraftUrl(event.target.value)}
              placeholder="ws://localhost:8765"
            />
            <button type="submit" className="button" disabled={draftUrl.trim() === websocketUrl}>
              {status === 'connected' ? 'Reconnect' : 'Connect'}
            </button>
          </div>
          <p className="panel__hint">
            Send one JSON message per frame. Reconnects automatically if the producer restarts.
          </p>
        </form>
      )}

      {sourceKind === 'playback' && <PlaybackPanel definition={definition} />}
    </section>
  );
}
