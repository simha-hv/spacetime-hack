/**
 * One WebSocket carrying both channels: text frames are control messages,
 * binary frames are input datagrams.
 *
 * Shared by host and controller. Deliberately NOT re-exported from index.ts —
 * the node server has no business importing browser WebSocket code.
 *
 * When WebRTC lands this class keeps doing control and signaling unchanged;
 * only `sendBinary`/`onBinary` get shadowed by the DataChannel transport.
 */

import { encodeControl, parseControl, type ControlMessage } from './control.js';
import { TIMING } from './constants.js';

export type Unsubscribe = () => void;

export interface CloseInfo {
  code: number;
  reason: string;
  /** False once we have stopped trying to reconnect. */
  willRetry: boolean;
}

function emitter<T extends unknown[]>() {
  const listeners: ((...args: T) => void)[] = [];
  return {
    add(cb: (...args: T) => void): Unsubscribe {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    emit(...args: T): void {
      for (const cb of listeners.slice()) cb(...args);
    },
  };
}

/**
 * If the socket has this many bytes queued, the network is stalled and we
 * drop new datagrams instead of adding to the backlog.
 *
 * This is the single most important line for feel over a WebSocket. TCP will
 * happily queue every snapshot behind a head-of-line block and then deliver
 * two seconds of stale input in a burst — the character rubber-bands through
 * a replay of where the thumb used to be. Dropping is correct: the snapshot
 * is a full state, so the next one supersedes anything we discard.
 */
const MAX_BUFFERED_BYTES = 512;

export class WsLink {
  private socket: WebSocket | null = null;
  private readonly openEvents = emitter<[]>();
  private readonly controlEvents = emitter<[ControlMessage]>();
  private readonly binaryEvents = emitter<[Uint8Array]>();
  private readonly closeEvents = emitter<[CloseInfo]>();
  // Annotated: TIMING is `as const`, so inference would pin this to the
  // literal type of its initial value and reject the backoff assignment.
  private retryDelay: number = TIMING.reconnectMinMs;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;
  private openResolve: (() => void) | null = null;
  private openPromise: Promise<void> | null = null;

  /** Latest control-channel round trip, ms. Null until the first pong. */
  rttMs: number | null = null;
  /** Datagrams dropped because the socket was backed up. */
  droppedSends = 0;

  constructor(
    private readonly url: string,
    private readonly autoReconnect = true,
  ) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Multiple subscribers: the control layer and the input transport both listen. */
  onOpen = (cb: () => void): Unsubscribe => this.openEvents.add(cb);
  onControl = (cb: (msg: ControlMessage) => void): Unsubscribe => this.controlEvents.add(cb);
  onBinary = (cb: (data: Uint8Array) => void): Unsubscribe => this.binaryEvents.add(cb);
  onClosed = (cb: (info: CloseInfo) => void): Unsubscribe => this.closeEvents.add(cb);

  /**
   * Idempotent. Both the control layer and the input transport call this, and
   * whichever runs second must attach to the live socket rather than tear it
   * down — reopening mid-handshake drops the join that is already in flight
   * and leaves the page stuck retrying.
   */
  connect(): Promise<void> {
    this.closedByUs = false;

    const socket = this.socket;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return this.openPromise ?? Promise.resolve();
    }

    this.openPromise = new Promise<void>((resolve) => {
      this.openResolve = resolve;
    });
    this.open();
    return this.openPromise;
  }

  private open(): void {
    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.retryDelay = TIMING.reconnectMinMs;
      this.startPing();
      this.openEvents.emit();
      this.openResolve?.();
      this.openResolve = null;
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        const msg = parseControl(event.data);
        if (!msg) return;
        if (msg.t === 'pong') {
          this.rttMs = Math.round(performance.now() - msg.ts);
          return;
        }
        this.controlEvents.emit(msg);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        this.binaryEvents.emit(new Uint8Array(event.data));
      }
    };

    socket.onerror = () => {
      /* onclose always follows; nothing useful to do here */
    };

    socket.onclose = (event: CloseEvent) => {
      this.stopPing();
      this.socket = null;

      // 4001..4004 are terminal join failures — retrying just loops.
      const terminal = event.code >= 4001 && event.code <= 4004;
      const willRetry = this.autoReconnect && !this.closedByUs && !terminal;

      this.closeEvents.emit({ code: event.code, reason: event.reason, willRetry });

      if (willRetry) this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    // Jitter so four phones that dropped together do not stampede back at once.
    const jitter = 0.7 + Math.random() * 0.6;
    const delay = Math.min(this.retryDelay * jitter, TIMING.reconnectMaxMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 2, TIMING.reconnectMaxMs);
      this.open();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendControl({ t: 'ping', ts: performance.now() });
    }, TIMING.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  sendControl(msg: ControlMessage): void {
    if (!this.isOpen) return;
    this.socket!.send(encodeControl(msg));
  }

  /** Fire-and-forget. Drops rather than queues when the socket is backed up. */
  sendBinary(bytes: Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.droppedSends++;
      return;
    }
    socket.send(bytes);
  }

  close(): void {
    this.closedByUs = true;
    this.stopPing();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      this.socket?.close(1000, 'client_close');
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  /** Force an immediate reconnect attempt (e.g. on `visibilitychange`). */
  poke(): void {
    if (this.isOpen || this.closedByUs) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDelay = TIMING.reconnectMinMs;
    this.open();
  }
}

/** Build the ws:// or wss:// URL for the current page. */
export function wsUrlFor(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
