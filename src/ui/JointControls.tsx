import { useCallback } from 'react';
import type { RobotDefinition } from '../robots/types';
import { armBuses, type ArmSlot } from '../state/jointBus';
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
  const dualArm = useSimulatorStore((state) => state.dualArm);
  const activeArm = useSimulatorStore((state) => state.activeArm);
  const setActiveArm = useSimulatorStore((state) => state.setActiveArm);

  const isManual = sourceKind === 'manual';
  const buses = armBuses[activeArm];
  // Sampled at display rate so dragging a slider feels direct.
  const commanded = useJointSnapshot(buses.target, 60);
  const rendered = useJointSnapshot(buses.displayed, 20);
  const { clampedJoints } = useDiagnostics();

  const handleChange = useCallback(
    (jointName: string, value: number) => {
      armBuses[activeArm].target.set(jointName, value);
    },
    [activeArm],
  );

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Joints</h2>
        <button type="button" className="button button--ghost" onClick={homeRobot}>
          Home
        </button>
      </header>

      {dualArm && (
        <div className="segmented" role="group" aria-label="Arm to jog">
          {(['left', 'right'] as ArmSlot[]).map((slot) => (
            <button
              key={slot}
              type="button"
              className={`segmented__option ${activeArm === slot ? 'is-active' : ''}`}
              aria-pressed={activeArm === slot}
              onClick={() => setActiveArm(slot)}
            >
              {slot === 'left' ? 'Left arm' : 'Right arm'}
            </button>
          ))}
        </div>
      )}

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
                <label htmlFor={`joint-${activeArm}-${joint.urdfName}`} className="joint__label">
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
                id={`joint-${activeArm}-${joint.urdfName}`}
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
