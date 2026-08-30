import { useSimulatorStore } from '../state/store';

export function ViewOptions() {
  const showGrid = useSimulatorStore((state) => state.showGrid);
  const toggleGrid = useSimulatorStore((state) => state.toggleGrid);
  const showJointAxes = useSimulatorStore((state) => state.showJointAxes);
  const toggleJointAxes = useSimulatorStore((state) => state.toggleJointAxes);
  const smoothing = useSimulatorStore((state) => state.smoothing);
  const setSmoothing = useSimulatorStore((state) => state.setSmoothing);

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>View</h2>
      </header>

      <label className="checkbox">
        <input type="checkbox" checked={showGrid} onChange={toggleGrid} />
        Ground grid
      </label>

      <label className="checkbox">
        <input type="checkbox" checked={showJointAxes} onChange={toggleJointAxes} />
        Joint axes
      </label>

      <div className="field">
        <label htmlFor="smoothing">
          Smoothing <span className="muted">{smoothing === 0 ? 'off' : `${smoothing.toFixed(2)} s`}</span>
        </label>
        <input
          id="smoothing"
          className="joint__slider"
          type="range"
          min={0}
          max={0.6}
          step={0.01}
          value={smoothing}
          onChange={(event) => setSmoothing(Number(event.target.value))}
        />
        <p className="panel__hint">
          Eases the arm toward incoming targets. Raise it for choppy or low-rate streams.
        </p>
      </div>
    </section>
  );
}
