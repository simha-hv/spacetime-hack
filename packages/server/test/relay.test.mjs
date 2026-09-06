import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import {
  BUTTON_A,
  encodeSnapshot,
  unrouteSnapshot,
  writeCounter,
} from '../../../dist/test/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = 18099;
const WS_URL = `ws://127.0.0.1:${PORT}/brawl-games/ws`;

let server;

before(async () => {
  server = spawn(process.execPath, [path.join(root, 'dist/server/index.js')], {
    env: { ...process.env, PORT: String(PORT), QUIET: '1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitForPort();
});

after(() => server?.kill('SIGTERM'));

async function waitForPort() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/brawl-games/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(50);
  }
  throw new Error('server did not start');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A socket wrapper that queues control messages and binary frames. */
function client() {
  const ws = new WebSocket(WS_URL);
  const control = [];
  const binary = [];
  const waiters = [];

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      binary.push(new Uint8Array(data));
    } else {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'pong') return;
      control.push(msg);
      for (const w of waiters.splice(0)) w();
    }
  });

  return {
    ws,
    control,
    binary,
    open: () => new Promise((r) => (ws.readyState === WebSocket.OPEN ? r() : ws.once('open', r))),
    send: (msg) => ws.send(JSON.stringify(msg)),
    sendBinary: (bytes) => ws.send(bytes),
    /** Wait for a control message of type `t`. */
    async expect(t, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = control.find((m) => m.t === t);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for "${t}"; saw ${control.map((m) => m.t).join(', ')}`);
        }
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
    close: () => ws.close(),
  };
}

async function newRoom() {
  const host = client();
  await host.open();
  host.send({ t: 'host_hello' });
  const welcome = await host.expect('host_welcome');
  return { host, welcome };
}

/* ------------------------------- the tests ------------------------------- */

test('host gets a 4-char code from the unambiguous alphabet', async () => {
  const { host, welcome } = await newRoom();
  assert.match(welcome.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  assert.doesNotMatch(welcome.code, /[O0I1]/, 'no ambiguous characters');
  assert.match(welcome.joinUrl, /\/brawl-games\/j\/[A-Z0-9]{4}$/);
  host.close();
});

test('controller joins, gets slot 0 and its colour', async () => {
  const { host, welcome } = await newRoom();
  const pad = client();
  await pad.open();
  pad.send({ t: 'join', code: welcome.code });

  const joined = await pad.expect('joined');
  assert.equal(joined.slot, 0);
  assert.equal(joined.colorName, 'RED');
  assert.equal(joined.resumed, false);
  assert.ok(joined.token);

  const announce = await host.expect('player_join');
  assert.equal(announce.slot, 0);

  pad.close();
  host.close();
});

test('four players get four distinct slots; a fifth is refused', async () => {
  const { host, welcome } = await newRoom();
  const pads = [];
  for (let i = 0; i < 4; i++) {
    const pad = client();
    await pad.open();
    pad.send({ t: 'join', code: welcome.code });
    const joined = await pad.expect('joined');
    assert.equal(joined.slot, i);
    pads.push(pad);
  }

  const fifth = client();
  await fifth.open();
  fifth.send({ t: 'join', code: welcome.code });
  const err = await fifth.expect('join_error');
  assert.equal(err.reason, 'room_full');

  for (const p of pads) p.close();
  host.close();
});

test('a leaving player frees their slot for the next joiner', async () => {
  const { host, welcome } = await newRoom();

  const first = client();
  await first.open();
  first.send({ t: 'join', code: welcome.code });
  await first.expect('joined');

  const second = client();
  await second.open();
  second.send({ t: 'join', code: welcome.code });
  const secondJoined = await second.expect('joined');
  assert.equal(secondJoined.slot, 1, 'joins alongside, does not disrupt slot 0');

  first.close();
  const stale = await host.expect('player_stale');
  assert.equal(stale.slot, 0, 'slot is held, not freed, during the grace window');

  second.close();
  host.close();
});

test('input datagrams reach the host with a slot byte prepended, unchanged', async () => {
  const { host, welcome } = await newRoom();
  const pad = client();
  await pad.open();
  pad.send({ t: 'join', code: welcome.code });
  await pad.expect('joined');
  await host.expect('player_join');

  const buttons = writeCounter(0, BUTTON_A, 2);
  const snap = { seq: 251, axisX: -64, axisY: 100, buttons };
  pad.sendBinary(encodeSnapshot(snap));

  for (let i = 0; i < 60 && host.binary.length === 0; i++) await sleep(25);
  assert.equal(host.binary.length, 1, 'exactly one frame relayed');

  const { slot, snapshot } = unrouteSnapshot(host.binary[0]);
  assert.equal(slot, 0);
  assert.deepEqual(snapshot, snap, 'the server did not touch the payload');

  pad.close();
  host.close();
});

test('a returning player reclaims the same slot and colour with their token', async () => {
  const { host, welcome } = await newRoom();

  const pad = client();
  await pad.open();
  pad.send({ t: 'join', code: welcome.code });
  const first = await pad.expect('joined');

  // Someone else joins while they are away, and must not steal the slot.
  const other = client();
  await other.open();
  other.send({ t: 'join', code: welcome.code });
  const otherJoined = await other.expect('joined');
  assert.equal(otherJoined.slot, 1);

  // Backgrounded Safari: socket dies.
  pad.close();
  await host.expect('player_stale');

  // ...and comes back with the stashed token.
  const back = client();
  await back.open();
  back.send({ t: 'join', code: welcome.code, token: first.token });
  const resumed = await back.expect('joined');

  assert.equal(resumed.resumed, true);
  assert.equal(resumed.slot, first.slot, 'same slot');
  assert.equal(resumed.color, first.color, 'same colour');
  assert.equal(resumed.colorName, first.colorName);

  back.close();
  other.close();
  host.close();
});

test('an unknown room code is refused', async () => {
  const pad = client();
  await pad.open();
  pad.send({ t: 'join', code: 'ZZZZ' });
  const err = await pad.expect('join_error');
  assert.equal(err.reason, 'no_room');
  pad.close();
});

test('a malformed code is refused as bad_code', async () => {
  const pad = client();
  await pad.open();
  pad.send({ t: 'join', code: 'X' });
  const err = await pad.expect('join_error');
  assert.equal(err.reason, 'bad_code');
  pad.close();
});

test('lowercase codes are accepted', async () => {
  const { host, welcome } = await newRoom();
  const pad = client();
  await pad.open();
  pad.send({ t: 'join', code: welcome.code.toLowerCase() });
  const joined = await pad.expect('joined');
  assert.equal(joined.code, welcome.code);
  pad.close();
  host.close();
});

test('the host reclaims its room and its players after a reload', async () => {
  const { host, welcome } = await newRoom();
  const pad = client();
  await pad.open();
  pad.send({ t: 'join', code: welcome.code });
  await pad.expect('joined');
  await host.expect('player_join');

  host.close();
  await sleep(100);

  const reloaded = client();
  await reloaded.open();
  reloaded.send({ t: 'host_hello', resume: welcome.hostToken });
  const welcomeAgain = await reloaded.expect('host_welcome');

  assert.equal(welcomeAgain.code, welcome.code, 'same room code across a host reload');
  assert.equal(welcomeAgain.players.length, 1, 'the player is still there');
  assert.equal(welcomeAgain.players[0].slot, 0);

  pad.close();
  reloaded.close();
});

test('the server rejects input from a socket that never joined', async () => {
  const { host, welcome } = await newRoom();
  const stranger = client();
  await stranger.open();
  stranger.sendBinary(encodeSnapshot({ seq: 1, axisX: 100, axisY: 0, buttons: 0 }));
  await sleep(200);
  assert.equal(host.binary.length, 0, 'nothing relayed from an unjoined socket');
  stranger.close();
  host.close();
  void welcome;
});

test('the server drops malformed input frames', async () => {
  const { host, welcome } = await newRoom();
  const pad = client();
  await pad.open();
  pad.send({ t: 'join', code: welcome.code });
  await pad.expect('joined');

  pad.sendBinary(new Uint8Array([1, 2, 3]));
  pad.sendBinary(new Uint8Array(64));
  await sleep(200);
  assert.equal(host.binary.length, 0, 'wrong-sized frames are discarded, not forwarded');

  pad.close();
  host.close();
});

/* ---------------------------- name / colour ------------------------------ */
test('a player can set a name and colour after joining', async () => {
  const { host, welcome } = await newRoom();
  const pad = client();
  await pad.open();
  pad.send({ t: 'join', code: welcome.code });
  const joined = await pad.expect('joined');
  assert.equal(joined.name, '', 'joins with no name — nothing blocks getting in');
  await host.expect('player_join');

  pad.send({ t: 'set_profile', name: 'Priya', color: '#b06dff' });
  const profile = await pad.expect('profile');

  assert.equal(profile.name, 'Priya');
  assert.equal(profile.color, '#b06dff');
  assert.equal(profile.colorName, 'PURPLE');
  assert.equal(profile.error, undefined);

  const announced = await host.expect('player_profile');
  assert.equal(announced.slot, joined.slot);
  assert.equal(announced.name, 'Priya');
  assert.equal(announced.color, '#b06dff');

  pad.close();
  host.close();
});

test('two players cannot hold the same colour', async () => {
  const { host, welcome } = await newRoom();

  const one = client();
  await one.open();
  one.send({ t: 'join', code: welcome.code });
  const oneJoined = await one.expect('joined');

  const two = client();
  await two.open();
  two.send({ t: 'join', code: welcome.code });
  const twoJoined = await two.expect('joined');

  assert.notEqual(oneJoined.color, twoJoined.color, 'auto-assignment never collides');

  // Player two tries to take player one's colour.
  two.send({ t: 'set_profile', color: oneJoined.color });
  const result = await two.expect('profile');

  assert.equal(result.error, 'color_taken');
  assert.equal(result.color, twoJoined.color, 'keeps its own colour, no silent swap');

  one.close();
  two.close();
  host.close();
});

test('releasing a colour makes it available to someone else', async () => {
  const { host, welcome } = await newRoom();

  const one = client();
  await one.open();
  one.send({ t: 'join', code: welcome.code });
  const oneJoined = await one.expect('joined');   // RED

  const two = client();
  await two.open();
  two.send({ t: 'join', code: welcome.code });
  await two.expect('joined');                      // BLUE

  // Player one moves to a free colour, freeing red.
  one.send({ t: 'set_profile', color: '#35d6d6' });
  await one.expect('profile');

  two.send({ t: 'set_profile', color: oneJoined.color });
  const result = await two.expect('profile');
  assert.equal(result.error, undefined);
  assert.equal(result.color, oneJoined.color, 'the freed colour was taken cleanly');

  one.close();
  two.close();
  host.close();
});

test('lobby broadcasts live colour availability', async () => {
  const { host, welcome } = await newRoom();

  const one = client();
  await one.open();
  one.send({ t: 'join', code: welcome.code });
  const oneJoined = await one.expect('joined');
  assert.ok(Array.isArray(oneJoined.taken));

  const two = client();
  await two.open();
  two.send({ t: 'join', code: welcome.code });
  await two.expect('joined');

  // Player one should have been told a second colour is now spoken for.
  await sleep(150);
  const lobbies = one.control.filter((m) => m.t === 'lobby');
  const latest = lobbies[lobbies.length - 1];
  assert.equal(latest.taken.length, 2, 'both colours listed as taken');

  one.close();
  two.close();
  host.close();
});

test('the server sanitizes names rather than trusting the phone', async () => {
  const { host, welcome } = await newRoom();
  const pad = client();
  await pad.open();
  pad.send({ t: 'join', code: welcome.code });
  await pad.expect('joined');

  pad.send({ t: 'set_profile', name: '  <script>alert(1)</script>  ' });
  const profile = await pad.expect('profile');
  assert.ok(!profile.name.includes('<'), `angle brackets stripped, got ${profile.name}`);
  assert.ok(profile.name.length <= 12, 'length capped server-side');

  pad.close();
  host.close();
});

test('name and colour survive a reconnect', async () => {
  const { host, welcome } = await newRoom();
  const pad = client();
  await pad.open();
  pad.send({ t: 'join', code: welcome.code });
  const joined = await pad.expect('joined');

  pad.send({ t: 'set_profile', name: 'Ravi', color: '#ff8a3d' });
  await pad.expect('profile');

  pad.close();
  await host.expect('player_stale');

  const back = client();
  await back.open();
  back.send({ t: 'join', code: welcome.code, token: joined.token });
  const resumed = await back.expect('joined');

  assert.equal(resumed.resumed, true);
  assert.equal(resumed.name, 'Ravi', 'identity is not lost by backgrounding Safari');
  assert.equal(resumed.color, '#ff8a3d');

  back.close();
  host.close();
});

test('a set_profile from a socket that never joined is ignored', async () => {
  const stranger = client();
  await stranger.open();
  stranger.send({ t: 'set_profile', name: 'nobody' });
  await sleep(200);
  assert.equal(
    stranger.control.filter((m) => m.t === 'profile').length,
    0,
    'no profile response to an unjoined socket',
  );
  stranger.close();
});
