import {
  ROUTED_SNAPSHOT_BYTES,
  type DisconnectReason,
  type GamepadTransport,
  type PeerId,
  type TransportStats,
} from '@brawl/protocol';
import type { WsLink } from '@brawl/protocol/ws-link.js';

/**
 * Host-side input transport over the relay WebSocket.
 *
 * Receives routed 6-byte frames ([slot][seq][ax][ay][btn:u16]), strips the
 * routing byte and hands the raw 5-byte snapshot up. It does not decode the
 * snapshot — that is the input-state layer's job, and keeping the split here
 * is what lets an RTC transport drop in without touching game code.
 */
export class HostWsTransport implements GamepadTransport {
  private inputCb: ((peer: PeerId, snapshot: Uint8Array) => void) | null = null;
  private disconnectCb: ((peer: PeerId, reason: DisconnectReason) => void) | null = null;
  private unsubscribe: (() => void)[] = [];

  constructor(private readonly link: WsLink) {}

  async connect(): Promise<void> {
    this.unsubscribe.push(
      this.link.onBinary((data) => {
        if (data.byteLength !== ROUTED_SNAPSHOT_BYTES) return;
        // subarray, not slice: no copy on the hot path.
        this.inputCb?.(data[0]!, data.subarray(1));
      }),
    );
    // The link itself is opened by the control layer; if it is already up this
    // resolves immediately.
    if (!this.link.isOpen) await this.link.connect();
  }

  /** A host never sends input. Present so one RTC wrapper can serve both ends. */
  sendInput(_snapshot: Uint8Array): void {}

  onInput(cb: (peer: PeerId, snapshot: Uint8Array) => void): void {
    this.inputCb = cb;
  }

  onDisconnect(cb: (peer: PeerId, reason: DisconnectReason) => void): void {
    this.disconnectCb = cb;
  }

  /** Called by the control layer when the relay reports a slot went away. */
  notifyDisconnect(peer: PeerId, reason: DisconnectReason): void {
    this.disconnectCb?.(peer, reason);
  }

  stats(): TransportStats {
    return { kind: 'ws', connected: this.link.isOpen, rttMs: this.link.rttMs };
  }

  close(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }
}
