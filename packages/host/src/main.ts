import { MAX_PLAYERS, WS_PATH, type ControlMessage, type PlayerInfo } from '@brawl/protocol';
import { WsLink, wsUrlFor } from '@brawl/protocol/ws-link.js';

import { SlotInput } from './input-state.js';
import { LobbyPanel } from './lobby.js';
import { HostWsTransport } from './transport-ws.js';

/**
 * The big screen. Owns the ONLY simulation — phones send input and receive
 * lobby/UI state, never game state. No netcode: no prediction, no
 * reconciliation, no rollback. It is a gamepad receiver that runs a game.
 */

const HOST_TOKEN_KEY = 'brawl:host';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('game');
const lobbyRoot = $('lobby');
const hintEl = $('hint');
const debugEl = $('debug');
const soundHintEl = $('soundHint');
const addCpuBtn = $<HTMLButtonElement>('addCpu');

const lobby = new LobbyPanel(lobbyRoot);

/** Per-slot input. Kept across a disconnect so a returning player resumes. */
const inputs = new Map<number, SlotInput>();
const inputFor = (slot: number): SlotInput => {
  let state = inputs.get(slot);
  if (!state) {
    state = new SlotInput();
    inputs.set(slot, state);
  }
  return state;
};

/* ------------------------------- transport ------------------------------- */

const link = new WsLink(wsUrlFor(WS_PATH), true);
const transport = new HostWsTransport(link);

transport.onInput((slot, snapshot) => {
  inputFor(slot).ingest(snapshot, performance.now());
});

/* --------------------------------- game ---------------------------------- */

/**
 * Loaded lazily.
 *
 * Three plus the Rapier WASM is by far the largest thing the host loads, and
 * none of it is needed to paint the room code. Keeping it out of the entry
 * chunk means the QR — the thing people are actually waiting to scan — is on
 * screen long before the physics engine has finished compiling.
 */
type MatchLike = import('./game/match.js').Match;

let match: MatchLike | null = null;
/** In-flight boot, so concurrent callers share one attempt. */
let booting: Promise<void> | null = null;

/**
 * Single-flight.
 *
 * This is called both at startup and again on `host_welcome`, and the two
 * race: the `match` guard sits before an await, so without this both callers
 * sail past it and build TWO games — two simulations and two render loops
 * drawing to one canvas, with players added to only one of them.
 */
function bootGame(): Promise<void> {
  booting ??= bootGameOnce();
  return booting;
}

async function bootGameOnce(): Promise<void> {
  if (match) return;

  const [{ Match }, { Hud }] = await Promise.all([
    import('./game/match.js'),
    import('./game/hud.js'),
  ]);

  const hud = new Hud($('banner'), $('bannerSub'), $('roundTimer'), $('standings'), $('roundName'));

  const instance = new Match({
    onPhoneStatus: (status) => {
      // Host -> server -> that one phone. Pure UI: a banner and whether the
      // controls read as live. No positions, nothing simulated.
      link.sendControl({
        t: 'game_ui',
        slot: status.slot,
        phase: status.phase,
        title: status.title,
        detail: status.detail,
        youAlive: status.youAlive,
        ...(status.secondsLeft !== undefined ? { secondsLeft: status.secondsLeft } : {}),
      });
    },
    onHud: (state) => hud.update(state),
    onGameMenu: (menu) => {
      link.sendControl({
        t: 'game_menu',
        slot: menu.slot,
        games: menu.games,
        current: menu.current,
        canPick: menu.canPick,
      });
    },
  });

  await instance.start(canvas, inputs);
  match = instance;

  // Browsers refuse to play audio until the page has seen a real gesture, and
  // a TV may never be clicked. Take the first one we get, and say so until then.
  const unlock = (): void => {
    instance.unlockAudio();
    soundHintEl.classList.add('hidden');
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  soundHintEl.classList.remove('hidden');

  for (const player of roster.values()) {
    match.addPlayer({ slot: player.slot, color: player.color, name: player.name });
  }
  updateChrome();
}

/* -------------------------------- control -------------------------------- */

/** Everyone in the room, so a late-booting game can catch up. */
const roster = new Map<number, PlayerInfo>();

/** Diagnostics only: the most recent game pick a phone sent. */
let lastPick = 'none';

function onControl(msg: ControlMessage): void {
  switch (msg.t) {
    case 'host_welcome': {
      try {
        localStorage.setItem(HOST_TOKEN_KEY, msg.hostToken);
      } catch {
        /* private mode — we just lose room resume across reloads */
      }
      lobby.setRoom(msg.code, msg.joinUrl);
      lobby.setStatus(`room ${msg.code} · ready`, 'ok');

      for (const player of msg.players) {
        roster.set(player.slot, player);
        match?.addPlayer({ slot: player.slot, color: player.color, name: player.name });
      }
      updateChrome();
      void bootGame();
      return;
    }

    case 'player_join': {
      roster.set(msg.slot, {
        slot: msg.slot,
        color: msg.color,
        colorName: msg.colorName,
        name: msg.name,
        connected: true,
      });
      // Reset sequencing: a resumed player is on a new socket whose seq
      // restarts at 0, which would otherwise look stale for ~128 frames.
      inputFor(msg.slot).reset();
      match?.addPlayer({ slot: msg.slot, color: msg.color, name: msg.name });
      updateChrome();
      return;
    }

    case 'player_profile': {
      const existing = roster.get(msg.slot);
      if (existing) {
        existing.color = msg.color;
        existing.colorName = msg.colorName;
        existing.name = msg.name;
      }
      match?.updatePlayer({ slot: msg.slot, color: msg.color, name: msg.name });
      return;
    }

    case 'player_stale': {
      const input = inputFor(msg.slot);
      input.axisX = 0;
      input.axisY = 0;
      return;
    }

    case 'pick_game':
      // The phone asked for a game. The server stamped the slot; we do not
      // need it — a party game does not gate the picker on who tapped.
      lastPick = `${msg.id}@${Math.round(performance.now() / 100) / 10}s m${match ? 1 : 0} ${match?.debugState ?? '-'}`;
      match?.setGame(msg.id);
      return;

    case 'player_leave': {
      roster.delete(msg.slot);
      inputs.delete(msg.slot);
      match?.removePlayer(msg.slot);
      updateChrome();
      return;
    }

    case 'roster': {
      for (const player of msg.players) {
        roster.set(player.slot, player);
        match?.addPlayer({ slot: player.slot, color: player.color, name: player.name });
      }
      updateChrome();
      return;
    }

    default:
      return;
  }
}

function updateChrome(): void {
  const playing = roster.size > 0;
  hintEl.classList.toggle('hidden', playing);
  // Shrink the join panel out of the game's way, but never hide it: people
  // join and leave at any moment and the code has to stay scannable.
  lobbyRoot.classList.toggle('compact', playing);
  // The banner moves out of the join panel's way while the panel is full size.
  document.body.classList.toggle('attract', !playing);
  updateCpuButton();
}

/**
 * The CPU button reflects the SEAT count, not the phone count.
 *
 * A roof with three bots on it has one chair left whether or not anyone has
 * scanned, and offering a fourth bot that silently does nothing is worse than
 * a disabled button.
 */
function updateCpuButton(): void {
  const seats = match?.seats;
  if (!seats) {
    addCpuBtn.disabled = true;
    return;
  }
  addCpuBtn.disabled = seats.used >= seats.total;
  const free = seats.total - seats.used;
  addCpuBtn.firstChild!.textContent = free > 0 ? '+ Add CPU' : 'Roof is full';
  const caption = addCpuBtn.querySelector('small');
  if (caption) {
    caption.textContent =
      free > 0
        ? `${seats.cpus} CPU · ${free} SEAT${free === 1 ? '' : 'S'} FREE`
        : `${seats.cpus} CPU · 4 OF 4`;
  }
}

addCpuBtn.addEventListener('click', () => {
  match?.addCpu();
  updateCpuButton();
});

link.onControl(onControl);

link.onOpen(() => {
  let resume: string | undefined;
  try {
    resume = localStorage.getItem(HOST_TOKEN_KEY) ?? undefined;
  } catch {
    /* ignore */
  }
  link.sendControl(resume ? { t: 'host_hello', resume } : { t: 'host_hello' });
});

link.onClosed(({ willRetry }) => {
  lobby.setStatus(willRetry ? 'reconnecting…' : 'disconnected', willRetry ? 'warn' : 'bad');
});

// The host screen may sit on a TV for hours; if the tab is throttled and the
// socket dies, come back the moment it is visible again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') link.poke();
});

void transport.connect();
void bootGame();

/* --------------------------------- debug --------------------------------- */

setInterval(() => {
  const stats = transport.stats();
  // The match can seat and unseat CPUs on its own — a phone joining a full
  // roof evicts one — so the button is refreshed here rather than only on click.
  updateCpuButton();

  const lines = [
    `${stats.kind} · ${stats.connected ? 'open' : 'down'} · rtt ${stats.rttMs ?? '—'}ms`,
    `players ${roster.size}/${MAX_PLAYERS} · ${match ? match.currentGame.id : 'loading…'} · pick ${lastPick}`,
    `${match ? match.debugState : 'no match'}`,
  ];
  for (const [slot, input] of [...inputs].sort((a, b) => a[0] - b[0])) {
    lines.push(
      `p${slot + 1} ok ${input.accepted} stale ${input.discarded} ` +
        `x ${input.axisX.toFixed(2)} y ${input.axisY.toFixed(2)}`,
    );
  }
  debugEl.textContent = lines.join('\n');
}, 500);
