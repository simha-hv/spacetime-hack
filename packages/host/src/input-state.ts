import {
  axisToUnit,
  BUTTON_A,
  BUTTON_B,
  BUTTON_C,
  decodeSnapshot,
  diffPresses,
  isNewerSeq,
  readCounter,
  TIMING,
} from '@brawl/protocol';

/**
 * Per-slot input state. Latest-wins on axes, accumulate-and-drain on buttons.
 *
 * This is the only place that decodes a snapshot. The transport hands over
 * bytes; the game reads `axisX` / `takePresses()`.
 */
export class SlotInput {
  /** null until the first accepted frame. */
  private lastSeq: number | null = null;
  private lastButtons = 0;

  /** -1..1, already deadzoned by the controller. */
  axisX = 0;
  axisY = 0;

  /** Presses observed but not yet consumed by the game loop. */
  private pendingA = 0;
  private pendingB = 0;
  private pendingC = 0;

  /** performance.now() of the last accepted frame. */
  lastFrameAt = 0;

  /** Diagnostics. */
  accepted = 0;
  discarded = 0;

  /** Returns true if the frame was accepted. */
  ingest(bytes: Uint8Array, now: number): boolean {
    const snap = decodeSnapshot(bytes);

    if (this.lastSeq !== null && !isNewerSeq(snap.seq, this.lastSeq)) {
      // Stale or duplicate. Dropping it loses nothing: axes are latest-wins,
      // and the button counters are monotonic mod 4, so the newest frame we
      // do accept already accounts for every press in the frames we skipped.
      this.discarded++;
      return false;
    }

    const curA = readCounter(snap.buttons, BUTTON_A);
    const curB = readCounter(snap.buttons, BUTTON_B);
    const curC = readCounter(snap.buttons, BUTTON_C);

    if (this.lastSeq === null) {
      // First frame: adopt the counters as the baseline rather than reporting
      // up to 3 phantom presses from whatever the counter happened to be.
      this.lastButtons = snap.buttons;
    } else {
      this.pendingA += diffPresses(curA, readCounter(this.lastButtons, BUTTON_A));
      this.pendingB += diffPresses(curB, readCounter(this.lastButtons, BUTTON_B));
      this.pendingC += diffPresses(curC, readCounter(this.lastButtons, BUTTON_C));
      this.lastButtons = snap.buttons;
    }

    this.lastSeq = snap.seq;
    this.axisX = axisToUnit(snap.axisX);
    this.axisY = axisToUnit(snap.axisY);
    this.lastFrameAt = now;
    this.accepted++;
    return true;
  }

  /**
   * Consume the press counts accumulated since the last call.
   * Called once per rendered frame; presses are never observed twice.
   */
  takePresses(): { a: number; b: number; c: number } {
    const a = this.pendingA;
    const b = this.pendingB;
    const c = this.pendingC;
    this.pendingA = 0;
    this.pendingB = 0;
    this.pendingC = 0;
    return { a, b, c };
  }

  /**
   * Stop the character when input goes quiet. Buttons are NOT cleared — a
   * press that arrived just before the silence still deserves to fire.
   */
  expireIfSilent(now: number): void {
    if (this.lastFrameAt > 0 && now - this.lastFrameAt > TIMING.inputSilenceMs) {
      this.axisX = 0;
      this.axisY = 0;
    }
  }

  /** Forget sequencing so a reconnecting player does not look stale. */
  reset(): void {
    this.lastSeq = null;
    this.lastButtons = 0;
    this.axisX = 0;
    this.axisY = 0;
    this.pendingA = 0;
    this.pendingB = 0;
    this.pendingC = 0;
    this.lastFrameAt = 0;
  }
}
