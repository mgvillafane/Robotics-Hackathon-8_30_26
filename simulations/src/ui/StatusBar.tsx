import { useStreamRate } from '../hooks/useJointSnapshot';
import type { RobotDefinition } from '../robots/types';
import { useSimulatorStore } from '../state/store';
import type { UrdfState } from '../scene/useUrdfRobot';

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  connected: 'Live',
  error: 'Error',
  closed: 'Stopped',
};

export function StatusBar({
  definition,
  urdf,
}: {
  definition: RobotDefinition;
  urdf: UrdfState;
}) {
  const sourceKind = useSimulatorStore((state) => state.sourceKind);
  const status = useSimulatorStore((state) => state.status);
  const statusDetail = useSimulatorStore((state) => state.statusDetail);
  const rate = useStreamRate();

  const modelLabel =
    urdf.status === 'ready'
      ? 'URDF loaded'
      : urdf.status === 'loading'
        ? 'Loading URDF\u2026'
        : 'Placeholder model';

  return (
    <div className="statusbar">
      <div className="statusbar__group">
        <span className={`dot dot--${status}`} aria-hidden="true" />
        <strong>{STATUS_LABEL[status] ?? status}</strong>
        {statusDetail && <span className="muted">{statusDetail}</span>}
      </div>

      <div className="statusbar__group">
        <span className="muted">Source</span>
        <span>{sourceKind}</span>
      </div>

      <div className="statusbar__group">
        <span className="muted">Rate</span>
        <span>{rate} Hz</span>
      </div>

      <div className="statusbar__group">
        <span className="muted">Model</span>
        <span className={urdf.status === 'error' ? 'warn-text' : undefined}>{modelLabel}</span>
      </div>

      <div className="statusbar__group statusbar__group--end">
        <span className="muted">{definition.joints.length} DOF</span>
      </div>
    </div>
  );
}
