/**
 * The transport seam.
 *
 * There are two channels, split by what they need from the network — this
 * split is the whole point of the abstraction:
 *
 *   CONTROL  reliable, ordered, low rate.  join / slot assignment / roster /
 *            tokens / (later) WebRTC signaling.  ALWAYS a WebSocket, forever.
 *
 *   INPUT    unreliable-tolerant, fixed 30Hz, latest-wins, drops are fine.
 *            `WsInputTransport` today; `RtcInputTransport` over an unreliable
 *            DataChannel later.  WebSocket stays as a permanent fallback,
 *            because WebRTC fails on guest wifi with client isolation and on
 *            cellular without TURN.
 *
 * Today both ride the same socket (text frame = control, binary = input).
 * The interface is what lets them separate later without the host or the game
 * loop learning anything about it. When WebRTC lands, the WebSocket keeps
 * doing control *and* carries the signaling for the peer connection, and only
 * binary datagrams move. Fallback is then per-player and at runtime.
 */

/**
 * On the host, the slot number (0..3) a datagram came from.
 * On the controller, always {@link HOST_PEER} — there is only one peer.
 */
export type PeerId = number;

export const HOST_PEER: PeerId = -1;

export type DisconnectReason =
  | 'closed'
  | 'timeout'
  | 'host_gone'
  | 'room_full'
  | 'bad_code'
  | 'no_room'
  | 'replaced'
  | 'error';

/**
 * Symmetric on purpose: both ends implement the same shape, so one
 * `RTCPeerConnection` wrapper can serve host and controller alike.
 *
 * A controller never fires `onInput`; a host never calls `sendInput`.
 */
export interface GamepadTransport {
  /** Open the channel. Resolves once input can flow. */
  connect(): Promise<void>;

  /**
   * Fire-and-forget. MAY be dropped, reordered or duplicated — that is the
   * contract, and it is why snapshots carry a seq and rolling press counters.
   * Never throws, never blocks, never awaits an ack.
   */
  sendInput(snapshot: Uint8Array): void;

  /** Receive a datagram. `snapshot` is the raw 5 bytes, already unrouted. */
  onInput(cb: (peer: PeerId, snapshot: Uint8Array) => void): void;

  /** A peer went away (host: one slot; controller: the host/relay). */
  onDisconnect(cb: (peer: PeerId, reason: DisconnectReason) => void): void;

  close(): void;
}

/** Diagnostics a transport exposes for the on-screen debug readout. */
export interface TransportStats {
  /** Human label for which implementation is live, e.g. "ws" or "webrtc". */
  kind: string;
  connected: boolean;
  /** Round-trip time in ms from the control channel ping, or null if unknown. */
  rttMs: number | null;
}
