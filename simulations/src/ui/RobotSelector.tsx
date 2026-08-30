import { listRobots } from '../robots/registry';
import { useSimulatorStore } from '../state/store';

export function RobotSelector() {
  const robotId = useSimulatorStore((state) => state.robotId);
  const selectRobot = useSimulatorStore((state) => state.selectRobot);
  const robots = listRobots();

  const current = robots.find((robot) => robot.id === robotId);

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Robot</h2>
      </header>

      <select
        className="select"
        value={robotId}
        onChange={(event) => selectRobot(event.target.value)}
        aria-label="Select robot model"
      >
        {robots.map((robot) => (
          <option key={robot.id} value={robot.id}>
            {robot.name}
          </option>
        ))}
      </select>

      {current && (
        <p className="panel__hint">
          {current.description} <span className="muted">&mdash; {current.vendor}</span>
        </p>
      )}
    </section>
  );
}
