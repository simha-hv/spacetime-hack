import assert from 'node:assert/strict';
import test from 'node:test';

import { SlotInput } from '../../../dist/test/input-state.js';
import {
  BUTTON_A,
  BUTTON_B,
  BUTTON_C,
  encodeSnapshot,
  writeCounter,
} from '../../../dist/test/index.js';

/** Build a wire frame the way a controller would. */
const frame = (seq, x = 0, y = 0, a = 0, b = 0, c = 0) =>
  encodeSnapshot({
    seq,
    axisX: x,
    axisY: y,
    buttons: writeCounter(
      writeCounter(writeCounter(0, BUTTON_A, a), BUTTON_B, b),
      BUTTON_C,
      c,
    ),
  });

test('axes are latest-wins and scaled to -1..1', () => {
  const input = new SlotInput();
  input.ingest(frame(1, 127, -127), 0);
  assert.equal(input.axisX, 1);
  assert.equal(input.axisY, -1);

  input.ingest(frame(2, 0, 64), 0);
  assert.equal(input.axisX, 0);
  assert.ok(Math.abs(input.axisY - 64 / 127) < 1e-9);
});

test('stale frames are discarded and do not move the character', () => {
  const input = new SlotInput();
  input.ingest(frame(10, 100, 0), 0);
  const accepted = input.ingest(frame(9, -100, 0), 0);

  assert.equal(accepted, false);
  assert.ok(input.axisX > 0, 'the older frame did not overwrite the newer axes');
  assert.equal(input.discarded, 1);
  assert.equal(input.accepted, 1);
});

test('out-of-order burst keeps only the newest', () => {
  const input = new SlotInput();
  for (const [seq, x] of [
    [10, 10],
    [12, 30],
    [11, 20],
    [13, 40],
  ]) {
    input.ingest(frame(seq, x, 0), 0);
  }
  assert.equal(input.accepted, 3, '10, 12, 13 accepted');
  assert.equal(input.discarded, 1, '11 arrived late and was dropped');
  assert.ok(Math.abs(input.axisX - 40 / 127) < 1e-9, 'axes reflect seq 13');
});

test('sequence wraparound does not stall the slot', () => {
  const input = new SlotInput();
  let seq = 250;
  for (let i = 0; i < 20; i++) {
    input.ingest(frame(seq, 50, 0), 0);
    seq = (seq + 1) & 0xff;
  }
  assert.equal(input.accepted, 20, 'every frame accepted across the 255 -> 0 boundary');
  assert.equal(input.discarded, 0);
});

test('the first frame does not emit phantom presses', () => {
  const input = new SlotInput();
  // A controller that has been running a while arrives mid-stream with its
  // counters already at 3. Diffing against a zero baseline would report three
  // presses that never happened.
  input.ingest(frame(1, 0, 0, 3, 2), 0);
  assert.deepEqual(input.takePresses(), { a: 0, b: 0, c: 0 });
});

test('a tap that vanished between frames is still recovered', () => {
  const input = new SlotInput();
  input.ingest(frame(1, 0, 0, 0, 0), 0);
  // Between frame 1 and frame 2 the player pressed and released A. No frame
  // ever observed the finger down; only the counter moved.
  input.ingest(frame(2, 0, 0, 1, 0), 0);
  assert.deepEqual(input.takePresses(), { a: 1, b: 0, c: 0 });
});

test('presses accumulate across frames and drain exactly once', () => {
  const input = new SlotInput();
  input.ingest(frame(1, 0, 0, 0, 0), 0);
  input.ingest(frame(2, 0, 0, 1, 0), 0);
  input.ingest(frame(3, 0, 0, 2, 1), 0);

  assert.deepEqual(input.takePresses(), { a: 2, b: 1, c: 0 });
  assert.deepEqual(input.takePresses(), { a: 0, b: 0, c: 0 }, 'draining is destructive');
});

test('presses survive dropped frames in between', () => {
  const input = new SlotInput();
  input.ingest(frame(1, 0, 0, 0, 0), 0);
  // Frames 2 and 3 are lost on the wire. The player tapped A three times.
  input.ingest(frame(4, 0, 0, 3, 0), 0);
  assert.deepEqual(input.takePresses(), { a: 3, b: 0, c: 0 });
});

test('a stale frame does not double-count or lose a press', () => {
  const input = new SlotInput();
  input.ingest(frame(1, 0, 0, 0, 0), 0);
  input.ingest(frame(3, 0, 0, 2, 0), 0); // two presses
  input.ingest(frame(2, 0, 0, 1, 0), 0); // late; its press is already counted
  assert.deepEqual(input.takePresses(), { a: 2, b: 0, c: 0 }, 'exactly two, not one or three');
});

test('the three buttons are counted independently', () => {
  const input = new SlotInput();
  input.ingest(frame(1, 0, 0, 0, 0, 0), 0);
  input.ingest(frame(2, 0, 0, 1, 3, 2), 0);
  assert.deepEqual(input.takePresses(), { a: 1, b: 3, c: 2 });
});

test('a button sharing the u16 cannot bleed into its neighbours', () => {
  const input = new SlotInput();
  input.ingest(frame(1, 0, 0, 3, 3, 3), 0);
  // Every counter wraps 3 -> 0 at once. Each must report exactly one press,
  // not borrow from the bits next to it.
  input.ingest(frame(2, 0, 0, 0, 0, 0), 0);
  assert.deepEqual(input.takePresses(), { a: 1, b: 1, c: 1 });
});

test('silence zeroes the axes but never discards a pending press', () => {
  const input = new SlotInput();
  input.ingest(frame(1, 0, 0, 0, 0), 1000);
  input.ingest(frame(2, 127, 127, 1, 0), 1000);

  input.expireIfSilent(1400);
  assert.equal(input.axisX, 1, 'still within the 500ms window');

  input.expireIfSilent(1600);
  assert.equal(input.axisX, 0, 'character stops');
  assert.equal(input.axisY, 0);
  assert.deepEqual(input.takePresses(), { a: 1, b: 0, c: 0 }, 'the press still fires');
});

test('reset clears sequencing so a reconnecting player is not seen as stale', () => {
  const input = new SlotInput();
  input.ingest(frame(200, 100, 0), 0);

  // The player reconnects on a fresh socket, so their seq restarts at 1.
  // Without reset, seq 1 vs last 200 has a forward distance of 57 — accepted
  // by luck here, but a restart at any seq 128..199 behind would stall for
  // over a hundred frames. reset() removes the dependence on luck entirely.
  input.reset();
  const accepted = input.ingest(frame(1, -100, 0), 0);
  assert.equal(accepted, true);
  assert.ok(input.axisX < 0);
});
