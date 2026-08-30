import { useCallback } from 'react';
import type { RobotDefinition } from '../robots/types';
import { displayedJoints, targetJoints } from '../state/jointBus';
import { useJointSnapshot } from '../hooks/useJointSnapshot';
import { useDiagnostics } from '../hooks/useDiagnostics';
import { useSimulatorStore } from '../state/store';

const RAD_TO_DEG = 180 / Math.PI;
/** Within this many radians of a limit counts as sitting on it (~0.3°). */
const LIMIT_EPSILON = 0.005;

interface JointControlsProps {
  definition: RobotDefinition;
}

export function JointControls({ definition }: JointControlsProps) {
  const sourceKind = useSimulatorStore((state) => state.sourceKind);
  const limits = useSimulatorStore((state) => state.limits);
  const homeRobot = useSimulatorStore((state) => state.homeRobot);

  const isManual = sourceKind === 'manual';
  // Sampled at display rate so dragging a slider feels direct.
  const commanded = useJointSnapshot(targetJoints, 60);
  const rendered = useJointSnapshot(displayedJoints, 20);
  const { clampedJoints } = useDiagnostics();

  const handleChange = useCallback((jointName: string, value: number) => {
    targetJoints.set(jointName, value);
  }, []);

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Joints</h2>
        <button type="button" className="button button--ghost" onClick={homeRobot}>
          Home
        </button>
      </header>

      {!isManual && (
        <p className="panel__hint">
          Driven by the {sourceKind} source. Switch to Manual to move joints yourself.
        </p>
      )}

      <ul className="joints">
        {definition.joints.map((joint) => {
          const limit = limits[joint.urdfName] ?? { lower: joint.lower, upper: joint.upper };
          const value = commanded[joint.urdfName] ?? 0;
          const actual = rendered[joint.urdfName] ?? 0;
          const span = limit.upper - limit.lower;
          const fill = span > 0 ? ((actual - limit.lower) / span) * 100 : 0;

          const atLimit =
            actual <= limit.lower + LIMIT_EPSILON || actual >= limit.upper - LIMIT_EPSILON;
          // A command that had to be clamped is worth flagging even after the
          // joint has eased away from the limit.
          const wasClamped = clampedJoints.includes(joint.urdfName);

          return (
            <li key={joint.urdfName} className={`joint ${atLimit || wasClamped ? 'is-limited' : ''}`}>
              <div className="joint__row">
                <label htmlFor={`joint-${joint.urdfName}`} className="joint__label">
                  {joint.label}
                </label>
                {wasClamped ? (
                  <span className="badge badge--warn" title="Incoming command exceeded this joint's range">
                    clamped
                  </span>
                ) : (
                  atLimit && <span className="badge">limit</span>
                )}
                <output className="joint__value">{(actual * RAD_TO_DEG).toFixed(1)}&deg;</output>
              </div>

              <input
                id={`joint-${joint.urdfName}`}
                className="joint__slider"
                type="range"
                min={limit.lower}
                max={limit.upper}
                step={0.001}
                value={value}
                disabled={!isManual}
                onChange={(event) => handleChange(joint.urdfName, Number(event.target.value))}
              />

              <div className="joint__meter" aria-hidden="true">
                <span className="joint__meter-fill" style={{ width: `${fill}%` }} />
              </div>

              <div className="joint__range">
                <span>{(limit.lower * RAD_TO_DEG).toFixed(0)}&deg;</span>
                <code className="joint__key">{joint.streamKey}</code>
                <span>{(limit.upper * RAD_TO_DEG).toFixed(0)}&deg;</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
