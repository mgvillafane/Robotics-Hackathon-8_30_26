import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { PlaybackSource, parseTrajectoryFile } from '../io/playbackSource';
import {
  isPoseCapture,
  retargetPoseCapture,
  type ArmSide,
  type PoseMapping,
} from '../io/poseRetarget';
import type { RobotDefinition } from '../robots/types';
import { targetJoints } from '../state/jointBus';
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

  const [rawRecords, setRawRecords] = useState<unknown[] | null>(null);
  const [pose, setPose] = useState(false);
  const [side, setSide] = useState<ArmSide | 'auto'>('auto');
  const [mapping, setMapping] = useState<PoseMapping>('fit');
  const [fileName, setFileName] = useState('');
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const sourceRef = useRef<PlaybackSource | null>(null);
  // Read at construction only; changing limits mid-clip should not restart it.
  const limitsRef = useRef(limits);
  limitsRef.current = limits;

  // A pose capture holds body landmarks, not joint angles, so it is converted
  // before it reaches the trajectory player.
  const retargeted = useMemo(() => {
    if (!rawRecords || !pose) return null;
    return retargetPoseCapture(rawRecords, { robot: definition, limits, side, mapping });
  }, [rawRecords, pose, definition, limits, side, mapping]);

  const records = retargeted ? retargeted.records : rawRecords;

  useEffect(() => {
    if (!retargeted) return;
    pushLog(
      'info',
      `Pose capture: ${retargeted.side} arm, ${retargeted.usableFrames} of ` +
        `${retargeted.totalFrames} frames usable (${retargeted.detectedFrames} with a ` +
        `detection), longest gap ${retargeted.longestGapFrames} frames.`,
    );
  }, [retargeted, pushLog]);

  useEffect(() => {
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
        targetJoints.apply(frame.positions);
        if (frame.clamped?.length) diagnostics.markClamped(frame.clamped);
      },
      onStatus: (status, detail) => setStatus(status, detail),
    });
    setPlaying(source.isPlaying);

    return () => {
      source.stop();
      sourceRef.current = null;
    };
  }, [records, definition, loop, setStatus]);

  useEffect(() => {
    sourceRef.current?.setSpeed(speed);
  }, [speed]);

  useEffect(() => {
    let frameId = 0;
    const tick = () => {
      frameId = requestAnimationFrame(tick);
      const source = sourceRef.current;
      if (!source) return;
      setProgress(source.progress);
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
      const looksLikePose = isPoseCapture(parsed);
      setRawRecords(parsed);
      setPose(looksLikePose);
      setFileName(label);
      pushLog(
        'info',
        looksLikePose
          ? `Loaded ${parsed.length} pose frames from ${label}.`
          : `Loaded ${parsed.length} frames from ${label}.`,
      );
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
            accept=".json,.jsonl,.txt"
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
                onChange={(event) => setMapping(event.target.value as PoseMapping)}
              >
                <option value="fit">Fill joint range</option>
                <option value="direct">Keep captured scale</option>
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

          {retargeted.calibration.pan && (
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
            Shoulder pan, shoulder lift and elbow flex are driven. Wrist and gripper stay on
            the manual sliders, since this capture has no hand landmarks.
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
            onChange={(event) => sourceRef.current?.seek(Number(event.target.value))}
            aria-label="Playback position"
          />
        </>
      )}

      <p className="panel__hint">
        Accepts JSON Lines or a JSON array, holding either joint states or a MediaPipe pose
        capture, which is retargeted to the arm automatically.
      </p>
    </div>
  );
}
