export type SourceKind = 'manual' | 'websocket' | 'playback';

export type SourceStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'closed';

export interface JointFrame {
  /** URDF joint name mapped to a position in radians. */
  positions: Record<string, number>;
  /** Epoch milliseconds at which this client received the frame. */
  receivedAt: number;
  /** Producer-supplied epoch milliseconds, when the payload carried one. */
  sentAt?: number;
  /** Joints whose commanded value was outside the limits and got clamped. */
  clamped?: string[];
}

export interface SourceEvents {
  onFrame: (frame: JointFrame) => void;
  onStatus: (status: SourceStatus, detail?: string) => void;
}

export interface JointStateSource {
  readonly kind: SourceKind;
  start(events: SourceEvents): void;
  stop(): void;
}
