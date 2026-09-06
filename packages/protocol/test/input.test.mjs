import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUTTON_A,
  BUTTON_B,
  decodeSnapshot,
  diffPresses,
  encodeSnapshot,
  isNewerSeq,
  readCounter,
  routeSnapshot,
  SNAPSHOT_BYTES,
  unitToAxis,
  unrouteSnapshot,
  writeCounter,
} from '../../../dist/test/index.js';

test('snapshot is exactly 5 bytes and round-trips', () => {
  const snap = { seq: 200, axisX: -127, axisY: 127, buttons: 0xabcd };
  const bytes = encodeSnapshot(snap);
  assert.equal(bytes.byteLength, SNAPSHOT_BYTES);
  assert.deepEqual(decodeSnapshot(bytes), snap);
});

test('axes clamp and survive the signed byte boundary', () => {
  assert.equal(decodeSnapshot(encodeSnapshot({ seq: 0, axisX: -300, axisY: 300, buttons: 0 })).axisX, -127);
  assert.equal(decodeSnapshot(encodeSnapshot({ seq: 0, axisX: -300, axisY: 300, buttons: 0 })).axisY, 127);
  assert.equal(unitToAxis(-1), -127);
  assert.equal(unitToAxis(1), 127);
  assert.equal(unitToAxis(0), 0);
  // Rounding must happen before clamping, or 0.999 truncates to 126.
  assert.equal(unitToAxis(0.999), 127);
});

test('buttons u16 is little-endian on the wire', () => {
  const bytes = encodeSnapshot({ seq: 0, axisX: 0, axisY: 0, buttons: 0x1234 });
  assert.equal(bytes[3], 0x34, 'low byte first');
  assert.equal(bytes[4], 0x12, 'high byte second');
});

/* ------------------------- sequence wraparound ------------------------- */

test('isNewerSeq accepts forward motion', () => {
  assert.equal(isNewerSeq(1, 0), true);
  assert.equal(isNewerSeq(127, 0), true);
});

test('isNewerSeq rejects duplicates and stale frames', () => {
  assert.equal(isNewerSeq(5, 5), false, 'duplicate');
  assert.equal(isNewerSeq(4, 5), false, 'one behind');
  // Behind by 100 within the window. Note 0-vs-200 is NOT this case: its
  // forward distance is 56, i.e. a wrap, and must be accepted.
  assert.equal(isNewerSeq(100, 200), false, 'far behind');
  assert.equal(isNewerSeq(0, 200), true, '200 -> 0 is a wrap forward, not a rewind');
});

test('the accept window is exactly half the sequence space', () => {
  // 127 ahead is the furthest forward jump we will believe; 128 is ambiguous
  // (equidistant either way) and is treated as stale.
  assert.equal(isNewerSeq(127, 0), true, '+127 accepted');
  assert.equal(isNewerSeq(128, 0), false, '+128 ambiguous, rejected');
  assert.equal(isNewerSeq(129, 0), false, 'beyond the window, rejected');
});

test('isNewerSeq handles u8 wraparound in both directions', () => {
  assert.equal(isNewerSeq(3, 250), true, '250 -> 3 wrapped forward');
  assert.equal(isNewerSeq(0, 255), true, '255 -> 0 wrapped forward');
  assert.equal(isNewerSeq(250, 3), false, '3 -> 250 is stale, not a 247-frame jump');
  assert.equal(isNewerSeq(255, 0), false, '0 -> 255 is stale');
});

test('isNewerSeq walks a full wrap without a single false stale', () => {
  let last = 0;
  for (let i = 0; i < 1000; i++) {
    const next = (last + 1) & 0xff;
    assert.equal(isNewerSeq(next, last), true, `frame ${i}: ${last} -> ${next}`);
    last = next;
  }
});

test('out-of-order delivery: 10, 12, 11 accepts 10 and 12 only', () => {
  const accepted = [];
  let last = null;
  for (const seq of [10, 12, 11, 13]) {
    if (last === null || isNewerSeq(seq, last)) {
      accepted.push(seq);
      last = seq;
    }
  }
  assert.deepEqual(accepted, [10, 12, 13]);
});

/* --------------------------- button counters --------------------------- */

test('press counter diff recovers 0..3 presses', () => {
  assert.equal(diffPresses(0, 0), 0);
  assert.equal(diffPresses(1, 0), 1);
  assert.equal(diffPresses(3, 1), 2);
  assert.equal(diffPresses(0, 1), 3, 'wraps: 1 -> 2 -> 3 -> 0 is three presses');
  assert.equal(diffPresses(2, 3), 3, 'wraps across the top');
});

test('a tap pressed AND released between two frames still registers', () => {
  // Frame 1: nothing held, counter 0. Between frames the player taps twice:
  // press+release, press+release. Frame 2 observes nothing held, counter 2.
  // A boolean "is held" bit reads false in both frames and loses both taps.
  const frame1 = writeCounter(0, BUTTON_A, 0);
  const frame2 = writeCounter(0, BUTTON_A, 2);
  const presses = diffPresses(readCounter(frame2, BUTTON_A), readCounter(frame1, BUTTON_A));
  assert.equal(presses, 2, 'both taps recovered from counters alone');
});

test('dropping stale frames loses no presses', () => {
  // Counter goes 0 -> 1 -> 2 -> 3 across frames the host never sees, and the
  // one frame it does see carries 3. The diff must report all three.
  let last = 0;
  const observed = 3;
  assert.equal(diffPresses(observed, last), 3);
  last = observed;
  assert.equal(diffPresses(3, last), 0, 'no phantom repeat on the next identical frame');
});

test('the two buttons occupy independent bit fields', () => {
  let buttons = writeCounter(0, BUTTON_A, 3);
  buttons = writeCounter(buttons, BUTTON_B, 1);
  assert.equal(readCounter(buttons, BUTTON_A), 3);
  assert.equal(readCounter(buttons, BUTTON_B), 1);
  assert.equal(buttons, 0b0111, 'A in bits 0-1, B in bits 2-3');
  // Upper 12 bits stay clear — reserved for six more buttons.
  assert.equal(buttons & 0xfff0, 0);
});

test('counters survive an encode/decode round trip', () => {
  let buttons = writeCounter(0, BUTTON_A, 2);
  buttons = writeCounter(buttons, BUTTON_B, 3);
  const back = decodeSnapshot(encodeSnapshot({ seq: 7, axisX: 0, axisY: 0, buttons }));
  assert.equal(readCounter(back.buttons, BUTTON_A), 2);
  assert.equal(readCounter(back.buttons, BUTTON_B), 3);
});

/* ------------------------------- routing -------------------------------- */

test('routing adds exactly one slot byte and unroutes cleanly', () => {
  const snap = { seq: 42, axisX: -10, axisY: 20, buttons: 0b1001 };
  const routed = routeSnapshot(3, encodeSnapshot(snap));
  assert.equal(routed.byteLength, 6);
  assert.equal(routed[0], 3);
  const { slot, snapshot } = unrouteSnapshot(routed);
  assert.equal(slot, 3);
  assert.deepEqual(snapshot, snap);
});
