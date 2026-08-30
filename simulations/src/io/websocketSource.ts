import type { RobotDefinition } from '../robots/types';
import { JointStateParseError, parseJointStatePayload, type JointLimits } from './parse';
import type { JointStateSource, SourceEvents } from './types';

export interface WebSocketSourceOptions {
  url: string;
  robot: RobotDefinition;
  /**
   * Read as each message arrives rather than captured up front, so limits
   * discovered when the URDF finishes loading apply without reconnecting.
   */
  getLimits?: () => JointLimits | undefined;
  /** Reconnect automatically after an unclean close. Defaults to true. */
  reconnect?: boolean;
  /** Reports payloads that arrived but could not be understood. */
  onParseError?: (message: string) => void;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

/**
 * Consumes joint states from a WebSocket. Each message is one frame, in any of
 * the layouts `parseJointStatePayload` understands.
 */
export class WebSocketSource implements JointStateSource {
  readonly kind = 'websocket' as const;

  private socket?: WebSocket;
  private events?: SourceEvents;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer?: number;
  private stopped = false;

  constructor(private readonly options: WebSocketSourceOptions) {}

  start(events: SourceEvents): void {
    this.events = events;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket) {
      // Drop handlers first so the close does not trigger a reconnect.
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close();
      }
      this.socket = undefined;
    }
    this.events?.onStatus('closed');
  }

  private open(): void {
    const { url } = this.options;
    this.events?.onStatus('connecting', url);

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.events?.onStatus('error', error instanceof Error ? error.message : String(error));
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.backoff = INITIAL_BACKOFF_MS;
      this.events?.onStatus('connected', url);
    };

    socket.onmessage = (event) => {
      void this.handleMessage(event.data);
    };

    socket.onerror = () => {
      this.events?.onStatus('error', `Could not reach ${url}`);
    };

    socket.onclose = (event) => {
      if (this.stopped) return;
      this.events?.onStatus('closed', event.reason || `Connection closed (${event.code})`);
      this.scheduleReconnect();
    };
  }

  private async handleMessage(data: unknown): Promise<void> {
    let text: string;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof Blob) {
      text = await data.text();
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(data);
    } else {
      this.options.onParseError?.('Received a message in an unsupported binary format.');
      return;
    }

    try {
      const limits = this.options.getLimits?.();
      const parsed = parseJointStatePayload(text, this.options.robot, {
        ...(limits ? { limits } : {}),
      });
      this.events?.onFrame({
        positions: parsed.positions,
        receivedAt: Date.now(),
        clamped: parsed.clamped,
        ...(parsed.sentAt !== undefined ? { sentAt: parsed.sentAt } : {}),
      });
      if (parsed.unmatchedKeys.length > 0) {
        this.options.onParseError?.(`Unrecognised keys: ${parsed.unmatchedKeys.join(', ')}`);
      }
    } catch (error) {
      const message =
        error instanceof JointStateParseError
          ? error.message
          : `Failed to parse joint state: ${String(error)}`;
      this.options.onParseError?.(message);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.options.reconnect === false) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }
}
