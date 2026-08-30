import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { DualPlaybackSource, PlaybackSource, parseTrajectoryFile } from '../io/playbackSource';
import {
  isHandCapture,
  retargetHandCapture,
  type HandMapping,
  type HandRetargetResult,
} from '../io/handRetarget';
import {
  isPoseCapture,
  retargetPoseCapture,
  type ArmSide,
  type PoseMapping,
  type PoseRetargetResult,
} from '../io/poseRetarget';
import type { RobotDefinition } from '../robots/types';
import { buildCaptureCloud } from '../io/captureCloud';
import { workspaceForApproach } from '../io/so101Ik';
import { armBuses } from '../state/jointBus';
import { diagnostics } from '../state/diagnostics';
import { useSimulatorStore } from '../state/store';

const SAMPLE_URL = '/trajectories/so101_wave.jsonl';
const SPEEDS = [0.25, 0.5, 1, 2, 4];
const RAD_TO_DEG = 180 / Math.PI;
const ARM_OPTIONS = ['auto', 'left', 'right'] as const;
// The subject's own left and right, as the detector labels them, which is
// mirrored from the side of the screen they appear on in a front-facing video.
const ARM_LABELS: Record<ArmSide, string> = { left: 'Left', right: 'Right' };

export function PlaybackPanel({ definition }: { definition: RobotDefinition }) {
  const setStatus = useSimulatorStore((state) => state.setStatus);
  const pushLog = useSimulatorStore((state) => state.pushLog);
  const limits = useSimulatorStore((state) => state.limits);
  const dualArm = useSimulatorStore((state) => state.dualArm);
  const setDualArm = useSimulatorStore((state) => state.setDualArm);
  const setCaptureCloud = useSimulatorStore((state) => state.setCaptureCloud);
  const setPlaybackProgress = useSimulatorStore((state) => state.setPlaybackProgress);
  const workspaceApproach = useSimulatorStore((state) => state.workspaceApproach);

  const [rawRecords, setRawRecords] = useState<unknown[] | null>(null);
  const [captureKind, setCaptureKind] = useState<'pose' | 'hand' | null>(null);
  const [side, setSide] = useState<ArmSide | 'auto'>('auto');
  const [mapping, setMapping] = useState<HandMapping>('fit');
  const [fileName, setFileName] = useState('');
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const sourceRef = useRef<PlaybackSource | DualPlaybackSource | null>(null);
  const resumeRef = useRef({ progress: 0, playing: true });
  // Read at construction only; changing limits mid-clip should not restart it.
  const limitsRef = useRef(limits);
  limitsRef.current = limits;

  const poseMapping: PoseMapping = mapping === 'ik' ? 'fit' : mapping;

  // Landmark captures are converted before they reach the trajectory player.
  // Body pose and hand tracking share the same UI shape, so both land here.
  const retargeted = useMemo((): PoseRetargetResult | HandRetargetResult | null => {
    if (!rawRecords || !captureKind || dualArm) return null;
    if (captureKind === 'hand') {
      return retargetHandCapture(rawRecords, {
        robot: definition,
        limits,
        side,
        mapping,
        approach: workspaceApproach,
      });
    }
    return retargetPoseCapture(rawRecords, { robot: definition, limits, side, mapping: poseMapping });
  }, [rawRecords, captureKind, definition, limits, side, mapping, poseMapping, dualArm, workspaceApproach]);

  const leftRetargeted = useMemo((): PoseRetargetResult | HandRetargetResult | null => {
    if (!rawRecords || !captureKind || !dualArm) return null;
    if (captureKind === 'hand') {
      return retargetHandCapture(rawRecords, {
        robot: definition,
        limits,
        side: 'left',
        mapping,
        approach: workspaceApproach,
      });
    }
    return retargetPoseCapture(rawRecords, { robot: definition, limits, side: 'left', mapping: poseMapping });
  }, [rawRecords, captureKind, definition, limits, mapping, poseMapping, dualArm, workspaceApproach]);

  const rightRetargeted = useMemo((): PoseRetargetResult | HandRetargetResult | null => {
    if (!rawRecords || !captureKind || !dualArm) return null;
    if (captureKind === 'hand') {
      return retargetHandCapture(rawRecords, {
        robot: definition,
        limits,
        side: 'right',
        mapping,
        approach: workspaceApproach,
      });
    }
    return retargetPoseCapture(rawRecords, { robot: definition, limits, side: 'right', mapping: poseMapping });
  }, [rawRecords, captureKind, definition, limits, mapping, poseMapping, dualArm, workspaceApproach]);

  const records = retargeted ? retargeted.records : rawRecords;

  useEffect(() => {
    if (captureKind === 'hand' && mapping === 'ik') setDualArm(true);
    if (captureKind === 'pose' && mapping === 'ik') setMapping('fit');
  }, [captureKind, mapping, setDualArm]);

  useEffect(() => {
    if (dualArm && leftRetargeted && rightRetargeted) {
      pushLog(
        'info',
        `${captureKind === 'hand' ? 'Hand' : 'Pose'} capture, dual-arm${
          mapping === 'ik' ? ' IK' : ''
        }: left ${leftRetargeted.usableFrames} / right ${rightRetargeted.usableFrames} usable of ${leftRetargeted.totalFrames}.`,
      );
      return;
    }
    if (!retargeted) return;
    pushLog(
      'info',
      `${captureKind === 'hand' ? 'Hand' : 'Pose'} capture: ${retargeted.side} arm, ${retargeted.usableFrames} of ` +
        `${retargeted.totalFrames} frames usable (${retargeted.detectedFrames} with a ` +
        `detection), longest gap ${retargeted.longestGapFrames} frames.`,
    );
  }, [retargeted, leftRetargeted, rightRetargeted, captureKind, dualArm, mapping, pushLog]);

  useEffect(() => {
    const { progress: resumeAt, playing: wasPlaying } = resumeRef.current;

    if (dualArm && captureKind && leftRetargeted && rightRetargeted) {
      const source = new DualPlaybackSource(
        { records: leftRetargeted.records, robot: definition, limits: limitsRef.current, fps: 30 },
        { records: rightRetargeted.records, robot: definition, limits: limitsRef.current, fps: 30 },
        { loop },
      );
      sourceRef.current = source;
      source.start({
        onLeft: (frame) => {
          armBuses.left.target.apply(frame.positions);
          if (frame.clamped?.length) diagnostics.markClamped(frame.clamped);
        },
        onRight: (frame) => {
          armBuses.right.target.apply(frame.positions);
          if (frame.clamped?.length) diagnostics.markClamped(frame.clamped);
        },
        onStatus: (status, detail) => setStatus(status, detail),
      });
      if (resumeAt > 0) source.seek(resumeAt);
      if (!wasPlaying) source.pause();
      setPlaying(source.isPlaying);
      return () => {
        resumeRef.current = { progress: source.progress, playing: source.isPlaying };
        source.stop();
        sourceRef.current = null;
      };
    }

    if (!records || records.length === 0) return;

    const source = new PlaybackSource({
      records,
      robot: definition,
      limits: limitsRef.current,
      loop,
      fps: 30,
    });
    sourceRef.current = source;

    source.start({
      onFrame: (frame) => {
        armBuses.left.target.apply(frame.positions);
        if (frame.clamped?.length) diagnostics.markClamped(frame.clamped);
      },
      onStatus: (status, detail) => setStatus(status, detail),
    });
    if (resumeAt > 0) source.seek(resumeAt);
    if (!wasPlaying) source.pause();
    setPlaying(source.isPlaying);

    return () => {
      resumeRef.current = { progress: source.progress, playing: source.isPlaying };
      source.stop();
      sourceRef.current = null;
    };
  }, [records, leftRetargeted, rightRetargeted, captureKind, dualArm, definition, loop, setStatus]);

  useEffect(() => {
    sourceRef.current?.setSpeed(speed);
  }, [speed]);

  useEffect(() => {
    if (!rawRecords || !captureKind) {
      setCaptureCloud(null);
      return;
    }
    setCaptureCloud(
      buildCaptureCloud(rawRecords, { workspace: workspaceForApproach(workspaceApproach) }),
    );
  }, [rawRecords, captureKind, workspaceApproach, setCaptureCloud]);

  useEffect(() => () => setCaptureCloud(null), [setCaptureCloud]);

  useEffect(() => {
    let frameId = 0;
    const tick = () => {
      frameId = requestAnimationFrame(tick);
      const source = sourceRef.current;
      if (!source) return;
      setProgress(source.progress);
      setPlaybackProgress(source.progress);
      setPlaying(source.isPlaying);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, []);

  const ingest = (text: string, label: string) => {
    try {
      const parsed = parseTrajectoryFile(text);
      if (parsed.length === 0) {
        pushLog('warn', `${label} contained no frames.`);
        return;
      }
      const kind = isHandCapture(parsed) ? 'hand' : isPoseCapture(parsed) ? 'pose' : null;
      setRawRecords(parsed);
      setCaptureKind(kind);
      setFileName(label);
      setPlaybackProgress(0);
      pushLog(
        'info',
        kind === 'hand'
          ? `Loaded ${parsed.length} hand-tracking frames from ${label}.`
          : kind === 'pose'
            ? `Loaded ${parsed.length} pose frames from ${label}.`
            : `Loaded ${parsed.length} frames from ${label}.`,
      );
      if (kind) {
        pushLog('info', 'Capture landmarks will be plotted in the robot workspace.');
      }
    } catch (error) {
      pushLog('error', `Could not read ${label}: ${(error as Error).message}`);
    }
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    ingest(await file.text(), file.name);
    event.target.value = '';
  };

  const loadSample = async () => {
    try {
      const response = await fetch(SAMPLE_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      ingest(await response.text(), 'sample trajectory');
    } catch (error) {
      pushLog('error', `Sample trajectory unavailable: ${(error as Error).message}`);
    }
  };

  const togglePlay = () => {
    const source = sourceRef.current;
    if (!source) return;
    if (source.isPlaying) source.pause();
    else source.play();
    setPlaying(source.isPlaying);
  };

  return (
    <div className="stack">
      <div className="field__row">
        <label className="button button--ghost file-button">
          Choose file
          <input
            type="file"
            accept=".json,.jsonl,.txt,.csv,.tsv"
            onChange={onFileChange}
            hidden
          />
        </label>
        <button type="button" className="button button--ghost" onClick={loadSample}>
          Load sample
        </button>
      </div>

      {fileName && (
        <p className="panel__hint">
          <strong>{fileName}</strong>
          <span className="muted"> &mdash; {sourceRef.current?.frameCount ?? 0} frames</span>
        </p>
      )}

      {retargeted && (
        <>
          <div className="field">
            <span className="field__caption">Arm to follow</span>
            <div className="segmented" role="group" aria-label="Arm to follow">
              {ARM_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`segmented__option ${side === option ? 'is-active' : ''}`}
                  aria-pressed={side === option}
                  onClick={() => setSide(option)}
                >
                  {option === 'auto' ? `Auto \u2014 ${retargeted.side}` : ARM_LABELS[option]}
                  {option !== 'auto' && (
                    <span className="segmented__meta">
                      {Math.round(
                        (retargeted.tracking[option] / Math.max(1, retargeted.totalFrames)) * 100,
                      )}
                      %
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="field__row">
            <div className="field">
              <label htmlFor="pose-mapping">Mapping</label>
              <select
                id="pose-mapping"
                className="select select--compact"
                value={mapping}
                onChange={(event) => setMapping(event.target.value as HandMapping)}
              >
                <option value="fit">Fill joint range</option>
                <option value="direct">Keep captured scale</option>
                {captureKind === 'hand' && (
                  <option value="ik">IK from index (both arms)</option>
                )}
              </select>
            </div>
          </div>

          <p className="panel__hint">
            {retargeted.usableFrames} of {retargeted.totalFrames} frames usable
            {retargeted.detectedFrames < retargeted.totalFrames &&
              `; the detector found nobody in ${
                retargeted.totalFrames - retargeted.detectedFrames
              }`}
            . Longest gap {retargeted.longestGapFrames} frames, held as a still pose.
          </p>

          {captureKind === 'pose' && 'pan' in retargeted.calibration && retargeted.calibration.pan && (
            <p className="panel__hint">
              Shoulder swing spanned{' '}
              {(
                Math.abs(
                  retargeted.calibration.pan.from[1] - retargeted.calibration.pan.from[0],
                ) * RAD_TO_DEG
              ).toFixed(0)}
              &deg; in the capture, driving{' '}
              {(
                Math.abs(retargeted.calibration.pan.to[1] - retargeted.calibration.pan.to[0]) *
                RAD_TO_DEG
              ).toFixed(0)}
              &deg; of joint travel
              {mapping === 'fit'
                ? ', stretched to fill the range.'
                : ', matching the captured scale.'}
            </p>
          )}

          <p className="panel__hint">
            {captureKind === 'hand'
              ? mapping === 'ik'
                ? 'Index fingertip position is mapped into the robot workspace and solved with 3-DOF IK (shoulder pan, lift, elbow). Wrist stays straight; roll and gripper still come from the palm. Hands landmarks are not metric — the workspace fit is a calibration.'
                : 'Only wrist flex/roll and the gripper move. Shoulder and elbow stay put — this file has no upper-arm landmarks.'
              : 'Shoulder pan, shoulder lift and elbow flex are driven. Wrist and gripper stay on the manual sliders, since this capture has no hand landmarks.'}
          </p>
        </>
      )}

      {dualArm && leftRetargeted && rightRetargeted && (
        <>
          <p className="panel__hint">
            <strong>Left arm</strong> follows the subject&apos;s left (
            {Math.round((leftRetargeted.usableFrames / Math.max(1, leftRetargeted.totalFrames)) * 100)}
            % usable). <strong>Right arm</strong> follows the subject&apos;s right (
            {Math.round((rightRetargeted.usableFrames / Math.max(1, rightRetargeted.totalFrames)) * 100)}
            % usable).
          </p>
          <div className="field__row">
            <div className="field">
              <label htmlFor="pose-mapping-dual">Mapping</label>
              <select
                id="pose-mapping-dual"
                className="select select--compact"
                value={mapping}
                onChange={(event) => setMapping(event.target.value as HandMapping)}
              >
                <option value="fit">Fill joint range</option>
                <option value="direct">Keep captured scale</option>
                {captureKind === 'hand' && (
                  <option value="ik">IK from index (both arms)</option>
                )}
              </select>
            </div>
          </div>
          <p className="panel__hint">
            {captureKind === 'hand'
              ? mapping === 'ik'
                ? `Each arm reaches for that hand's index tip. Left solved ${
                    'ikSolved' in leftRetargeted ? leftRetargeted.ikSolved : 0
                  } / ${leftRetargeted.usableFrames} in reach, right ${
                    'ikSolved' in rightRetargeted ? rightRetargeted.ikSolved : 0
                  } / ${rightRetargeted.usableFrames}. Wrist stays straight; roll and gripper still come from the palm.`
                : 'Each arm gets wrist and gripper from that hand. Shoulders and elbows stay put.'
              : 'Each arm gets shoulder pan, lift and elbow from that side of the body.'}
          </p>
        </>
      )}

      {records && (
        <>
          <div className="field__row">
            <button type="button" className="button" onClick={togglePlay}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <select
              className="select select--compact"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              aria-label="Playback speed"
            >
              {SPEEDS.map((option) => (
                <option key={option} value={option}>
                  {option}&times;
                </option>
              ))}
            </select>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={loop}
                onChange={(event) => setLoop(event.target.checked)}
              />
              Loop
            </label>
          </div>

          <input
            className="joint__slider"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={progress}
            onChange={(event) => {
              const value = Number(event.target.value);
              sourceRef.current?.seek(value);
              setPlaybackProgress(value);
            }}
            aria-label="Playback position"
          />
        </>
      )}

      <p className="panel__hint">
        Accepts CSV, TSV, JSON Lines or a JSON array: joint states, a MediaPipe pose
        capture, or a hand-tracking table with gripper_value and wrist landmarks.
      </p>
    </div>
  );
}
