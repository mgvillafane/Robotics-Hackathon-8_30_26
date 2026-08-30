import type { RobotDefinition } from '../robots/types';
import { parseJointStatePayload, type JointLimits, type ParsedFrame } from './parse';
import type { JointStateSource, SourceEvents } from './types';

export interface PlaybackSourceOptions {
  /** Raw records, one per frame, in any layout the parser accepts. */
  records: unknown[];
  robot: RobotDefinition;
  limits?: JointLimits;
  /** Used when records carry no timestamps. Defaults to 30. */
  fps?: number;
  loop?: boolean;
}

interface Timed {
  positions: Record<string, number>;
  /** Offset from the start of the trajectory, in milliseconds. */
  offsetMs: number;
  /** Joints clamped to their limits when this frame was parsed. */
  clamped: string[];
}

/**
 * Replays a recorded trajectory. Uses per-record timestamps when present and
 * falls back to a fixed frame rate otherwise.
 */
export class PlaybackSource implements JointStateSource {
  readonly kind = 'playback' as const;

  private readonly frames: Timed[];
  private events?: SourceEvents;
  private rafId?: number;
  private startedAt = 0;
  private elapsedBeforePause = 0;
  private cursor = 0;
  private playing = false;
  private speed = 1;

  constructor(private readonly options: PlaybackSourceOptions) {
    this.frames = this.buildFrames();
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get durationMs(): number {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1].offsetMs : 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  private buildFrames(): Timed[] {
    const { records, robot, limits, fps = 30 } = this.options;
    const parsed: Array<ParsedFrame & { index: number }> = [];

    records.forEach((record, index) => {
      try {
        parsed.push({ ...parseJointStatePayload(record, robot, { limits }), index });
      } catch {
        // Skip malformed records rather than aborting the whole trajectory.
      }
    });

    if (parsed.length === 0) return [];

    const base = parsed[0].sentAt;
    const hasTimestamps = base !== undefined && parsed.every((frame) => frame.sentAt !== undefined);

    return parsed.map((frame) => ({
      positions: frame.positions,
      clamped: frame.clamped,
      offsetMs: hasTimestamps ? (frame.sentAt as number) - (base as number) : (frame.index * 1000) / fps,
    }));
  }

  start(events: SourceEvents): void {
    this.events = events;
    if (this.frames.length === 0) {
      events.onStatus('error', 'Trajectory contained no readable frames.');
      return;
    }
    events.onStatus('connected', `${this.frames.length} frames`);
    this.play();
  }

  stop(): void {
    this.pause();
    this.cursor = 0;
    this.elapsedBeforePause = 0;
    this.events?.onStatus('closed');
  }

  play(): void {
    if (this.playing || this.frames.length === 0) return;
    this.playing = true;
    this.startedAt = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.elapsedBeforePause += (performance.now() - this.startedAt) * this.speed;
    if (this.rafId !== undefined) {
      cancelAnimationFrame(this.rafId);
      this.rafId = undefined;
    }
  }

  setSpeed(speed: number): void {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.speed = Math.max(0.05, speed);
    if (wasPlaying) this.play();
  }

  /** Jump to a position in the trajectory, expressed as 0..1. */
  seek(progress: number): void {
    const clamped = Math.min(1, Math.max(0, progress));
    this.elapsedBeforePause = clamped * this.durationMs;
    this.startedAt = performance.now();
    this.cursor = 0;
    this.emitAt(this.elapsedBeforePause);
  }

  get progress(): number {
    if (this.durationMs === 0) return 0;
    return Math.min(1, this.currentTimeMs() / this.durationMs);
  }

  private currentTimeMs(): number {
    if (!this.playing) return this.elapsedBeforePause;
    return this.elapsedBeforePause + (performance.now() - this.startedAt) * this.speed;
  }

  private emitAt(timeMs: number): void {
    // Advance to the newest frame at or before timeMs.
    while (this.cursor + 1 < this.frames.length && this.frames[this.cursor + 1].offsetMs <= timeMs) {
      this.cursor += 1;
    }
    while (this.cursor > 0 && this.frames[this.cursor].offsetMs > timeMs) {
      this.cursor -= 1;
    }
    this.events?.onFrame({
      positions: this.frames[this.cursor].positions,
      clamped: this.frames[this.cursor].clamped,
      receivedAt: Date.now(),
    });
  }

  private readonly tick = (): void => {
    if (!this.playing) return;

    const time = this.currentTimeMs();
    this.emitAt(time);

    if (time >= this.durationMs) {
      if (this.options.loop) {
        this.elapsedBeforePause = 0;
        this.startedAt = performance.now();
        this.cursor = 0;
      } else {
        this.pause();
        this.events?.onStatus('closed', 'Playback finished');
        return;
      }
    }

    this.rafId = requestAnimationFrame(this.tick);
  };
}

/** Parses a `.jsonl` (one JSON object per line) or `.json` array trajectory. */
export function parseTrajectoryFile(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('Trajectory JSON must be an array of frames.');
    return parsed;
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => JSON.parse(line) as unknown);
}
