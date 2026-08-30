import { useSimulatorStore } from '../state/store';

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

export function LogPanel() {
  const log = useSimulatorStore((state) => state.log);
  const clearLog = useSimulatorStore((state) => state.clearLog);

  return (
    <section className="panel panel--grow">
      <header className="panel__header">
        <h2>Activity</h2>
        {log.length > 0 && (
          <button type="button" className="button button--ghost" onClick={clearLog}>
            Clear
          </button>
        )}
      </header>

      {log.length === 0 ? (
        <p className="panel__hint">Connection events and malformed payloads appear here.</p>
      ) : (
        <ul className="log">
          {log.map((entry) => (
            <li key={entry.id} className={`log__item log__item--${entry.level}`}>
              <time>{formatTime(entry.at)}</time>
              <span>{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
