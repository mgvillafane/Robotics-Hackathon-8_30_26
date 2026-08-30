import { useDiagnostics } from '../hooks/useDiagnostics';
import { GROUND } from '../scene/selfCollision';
import { useSimulatorStore } from '../state/store';

function linkLabel(name: string): string {
  if (name === GROUND) return name;
  return name.replace(/_link$/, '').replace(/_/g, ' ');
}

export function SafetyPanel() {
  const checkSelfCollision = useSimulatorStore((state) => state.checkSelfCollision);
  const toggleSelfCollision = useSimulatorStore((state) => state.toggleSelfCollision);
  const checkGroundCollision = useSimulatorStore((state) => state.checkGroundCollision);
  const toggleGroundCollision = useSimulatorStore((state) => state.toggleGroundCollision);
  const blockSelfCollision = useSimulatorStore((state) => state.blockSelfCollision);
  const toggleBlockSelfCollision = useSimulatorStore((state) => state.toggleBlockSelfCollision);
  const status = useSimulatorStore((state) => state.collisionStatus);
  const stats = useSimulatorStore((state) => state.collisionStats);

  const { collisions, checkCostMs, blocking } = useDiagnostics();

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Safety</h2>
        {status === 'building' && <span className="muted">building&hellip;</span>}
      </header>

      <label className="checkbox">
        <input type="checkbox" checked={checkSelfCollision} onChange={toggleSelfCollision} />
        Detect self-collisions
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={checkGroundCollision}
          disabled={!checkSelfCollision}
          onChange={toggleGroundCollision}
        />
        Detect mounting-surface contact
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={blockSelfCollision}
          disabled={!checkSelfCollision}
          onChange={toggleBlockSelfCollision}
        />
        Block motion on contact
      </label>

      <p className="panel__hint">
        {blockSelfCollision
          ? 'The arm holds its last collision-free pose instead of passing through itself.'
          : 'Contacts are reported and highlighted, but the arm still moves through them.'}
      </p>

      {checkSelfCollision && status === 'ready' && (
        <>
          {collisions.length === 0 ? (
            <p className="status-line status-line--ok">
              <span className="dot dot--connected" aria-hidden="true" />
              Clear
              <span className="muted">
                {checkCostMs < 0.05 ? '<0.1' : checkCostMs.toFixed(1)} ms/frame
              </span>
            </p>
          ) : (
            <div className="status-line status-line--bad">
              <span className="dot dot--error" aria-hidden="true" />
              <div>
                <strong>
                  {collisions.length} contact{collisions.length > 1 ? 's' : ''}
                  {blocking && ' \u2014 holding'}
                </strong>
                <ul className="contact-list">
                  {collisions.map((pair) => (
                    <li key={`${pair.a}~${pair.b}`}>
                      {linkLabel(pair.a)} &harr; {linkLabel(pair.b)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {stats && (
            <p className="panel__hint">
              {stats.pairs} link pairs tested each frame
              {checkGroundCollision && ', plus the mounting surface'}, {stats.ignoredAlways}{' '}
              ignored as permanently overlapping. {(stats.triangles / 1000).toFixed(0)}k
              triangles indexed in {stats.buildMs.toFixed(0)} ms.
            </p>
          )}
        </>
      )}

      {status === 'unavailable' && (
        <p className="panel__hint warn-text">
          Collision model could not be built for this robot.
        </p>
      )}
    </section>
  );
}
