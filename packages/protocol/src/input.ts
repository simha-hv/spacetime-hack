/**
 * The input datagram.
 *
 * Wire format, 5 bytes, little-endian:
 *
 *   byte 0    seq      u8    wraps 0..255
 *   byte 1    axisX    i8    -127..127
 *   byte 2    axisY    i8    -127..127   (+Y = down, screen coords)
 *   byte 3-4  buttons  u16   LE, eight 2-bit rolling press counters
 *
 * Server -> host frames carry one extra leading routing byte:
 *
 *   byte 0    slot     u8    0..3
 *   byte 1-5  <the 5 bytes above>
 *
 * That prefix is the ONLY thing the server does to the input path. It is
 * routing, not game logic — the server never reads axes or buttons.
 */

export const SNAPSHOT_BYTES = 5;
export const ROUTED_SNAPSHOT_BYTES = SNAPSHOT_BYTES + 1;

export interface Snapshot {
  /** u8, wraps. */
  seq: number;
  /** i8, -127..127. */
  axisX: number;
  /** i8, -127..127. +Y is down. */
  axisY: number;
  /** u16, eight 2-bit press counters. */
  buttons: number;
}

/* ------------------------------------------------------------------ *
 * Buttons: 2-bit rolling press counters, NOT booleans.
 *
 * Each button owns 2 bits holding a press count mod 4, incremented by the
 * controller on every press. The host recovers the number of presses since
 * the last frame it accepted by subtracting mod 4.
 *
 * This is what makes a tap survive an unreliable transport: a press AND its
 * release can both happen between two delivered frames, so a boolean "is
 * held" bit would show `false` in both and the tap would vanish entirely.
 * A counter that moved from 1 to 2 proves the press happened even though no
 * frame ever observed the finger down.
 * ------------------------------------------------------------------ */

/** 16 bits / 2 bits per button. Three are used; five spare. */
export const BUTTON_COUNT = 8;

/** Punch. */
export const BUTTON_A = 0;
/** Grab, then press again to throw. */
export const BUTTON_B = 1;
/** Jump. */
export const BUTTON_C = 2;

/** Read one button's 2-bit counter out of the packed u16. */
export function readCounter(buttons: number, index: number): number {
  return (buttons >>> (index * 2)) & 0b11;
}

/** Write one button's 2-bit counter into the packed u16, returning the new u16. */
export function writeCounter(buttons: number, index: number, value: number): number {
  const shift = index * 2;
  return ((buttons & ~(0b11 << shift)) | ((value & 0b11) << shift)) & 0xffff;
}

/** Increment one button's counter (wrapping at 4). Called on press, never on release. */
export function bumpCounter(buttons: number, index: number): number {
  return writeCounter(buttons, index, readCounter(buttons, index) + 1);
}

/**
 * Presses that happened between two counter values, 0..3.
 *
 * Aliasing: 4 or more presses between two accepted frames alias to n mod 4.
 * At 30Hz that would be 4 taps inside 33ms, which a human thumb cannot do,
 * so we accept the bound rather than widening the field.
 */
export function diffPresses(current: number, last: number): number {
  return (current - last) & 0b11;
}

/* ------------------------------------------------------------------ *
 * Sequence numbers
 * ------------------------------------------------------------------ */

/**
 * Is `seq` newer than `last`, accounting for u8 wraparound?
 *
 * Treat the 8-bit space as a circle and ask whether the forward distance from
 * `last` to `seq` is less than half of it. 250 -> 3 is newer (distance 9);
 * 3 -> 250 is stale (distance 253). Equal is not newer, so duplicates drop.
 */
export function isNewerSeq(seq: number, last: number): boolean {
  const forward = (seq - last) & 0xff;
  return forward !== 0 && forward < 128;
}

/* ------------------------------------------------------------------ *
 * Encode / decode
 * ------------------------------------------------------------------ */

const clampAxis = (v: number): number => (v < -127 ? -127 : v > 127 ? 127 : v | 0);

/** Encode a snapshot into 5 bytes. Pass `into` to avoid allocating per tick. */
export function encodeSnapshot(s: Snapshot, into?: Uint8Array): Uint8Array {
  const bytes = into ?? new Uint8Array(SNAPSHOT_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint8(0, s.seq & 0xff);
  view.setInt8(1, clampAxis(s.axisX));
  view.setInt8(2, clampAxis(s.axisY));
  view.setUint16(3, s.buttons & 0xffff, true);
  return bytes;
}

/** Decode 5 bytes at `offset`. Throws if the buffer is too short. */
export function decodeSnapshot(bytes: Uint8Array, offset = 0): Snapshot {
  if (bytes.byteLength - offset < SNAPSHOT_BYTES) {
    throw new RangeError(
      `snapshot needs ${SNAPSHOT_BYTES} bytes, got ${bytes.byteLength - offset}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, SNAPSHOT_BYTES);
  return {
    seq: view.getUint8(0),
    axisX: view.getInt8(1),
    axisY: view.getInt8(2),
    buttons: view.getUint16(3, true),
  };
}

/** Prepend the slot routing byte. Server-side only. */
export function routeSnapshot(slot: number, snapshot: Uint8Array): Uint8Array {
  const out = new Uint8Array(ROUTED_SNAPSHOT_BYTES);
  out[0] = slot & 0xff;
  out.set(snapshot.subarray(0, SNAPSHOT_BYTES), 1);
  return out;
}

/** Split a routed frame back into slot + snapshot. Host-side only. */
export function unrouteSnapshot(bytes: Uint8Array): { slot: number; snapshot: Snapshot } {
  if (bytes.byteLength < ROUTED_SNAPSHOT_BYTES) {
    throw new RangeError(`routed frame needs ${ROUTED_SNAPSHOT_BYTES} bytes`);
  }
  return { slot: bytes[0]!, snapshot: decodeSnapshot(bytes, 1) };
}

/** Axis byte (-127..127) to a unit float (-1..1). */
export const axisToUnit = (v: number): number => v / 127;

/** Unit float (-1..1) to an axis byte. Rounds before clamping, not after. */
export const unitToAxis = (v: number): number => clampAxis(Math.round(v * 127));
