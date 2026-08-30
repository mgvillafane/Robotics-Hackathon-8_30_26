import { APPROACH_RANGE } from '../scene/staging';
import { useSimulatorStore } from '../state/store';

export function ViewOptions() {
  const showGrid = useSimulatorStore((state) => state.showGrid);
  const toggleGrid = useSimulatorStore((state) => state.toggleGrid);
  const showJointAxes = useSimulatorStore((state) => state.showJointAxes);
  const toggleJointAxes = useSimulatorStore((state) => state.toggleJointAxes);
  const smoothing = useSimulatorStore((state) => state.smoothing);
  const setSmoothing = useSimulatorStore((state) => state.setSmoothing);
  const dualArm = useSimulatorStore((state) => state.dualArm);
  const toggleDualArm = useSimulatorStore((state) => state.toggleDualArm);
  const showCaptureCloud = useSimulatorStore((state) => state.showCaptureCloud);
  const toggleCaptureCloud = useSimulatorStore((state) => state.toggleCaptureCloud);
  const captureCloud = useSimulatorStore((state) => state.captureCloud);
  const workspaceApproach = useSimulatorStore((state) => state.workspaceApproach);
  const setWorkspaceApproach = useSimulatorStore((state) => state.setWorkspaceApproach);

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

      <label className="checkbox">
        <input type="checkbox" checked={dualArm} onChange={toggleDualArm} />
        Two arms
      </label>
      <p className="panel__hint">
        Adds a second copy of this robot. Playback from a pose or hand capture
        sends the subject&apos;s left side to the left arm and the right side to
        the right arm.
      </p>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={showCaptureCloud}
          onChange={toggleCaptureCloud}
          disabled={!captureCloud}
        />
        Capture points
      </label>
      <p className="panel__hint">
        {captureCloud
          ? `Plots ${captureCloud.points.length.toLocaleString()} uploaded landmarks in the robot workspace. The yellow marker follows playback.`
          : 'Load a pose or hand CSV to plot its 3D landmarks here.'}
      </p>

      <div className="field">
        <label htmlFor="workspace-approach">
          Approach{' '}
          <span className="muted">{Math.round(workspaceApproach * 100)} cm closer</span>
        </label>
        <input
          id="workspace-approach"
          className="joint__slider"
          type="range"
          min={APPROACH_RANGE.min}
          max={APPROACH_RANGE.max}
          step={APPROACH_RANGE.step}
          value={workspaceApproach}
          onChange={(event) => setWorkspaceApproach(Number(event.target.value))}
        />
        <p className="panel__hint">
          Folds the elbow and tucks the wrist, and keeps the point cloud in
          front of the gripper instead of letting the arm pass through it.
        </p>
      </div>

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
