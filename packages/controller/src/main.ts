import {
  defaultName,
  JOIN_PATH_PREFIX,
  tokenStorageKey,
  WS_PATH,
  type ControlMessage,
} from '@brawl/protocol';
import { WsLink, wsUrlFor } from '@brawl/protocol/ws-link.js';

import { Buttons } from './buttons.js';
import { CustomiseSheet, loadPreferences, savePreferences } from './customise.js';
import { Stick } from './stick.js';
import { InputTicker } from './ticker.js';
import { ControllerWsTransport } from './transport-ws.js';
import { WakeLock } from './wakelock.js';

/**
 * The phone. It is a gamepad, not a game client: it sends input snapshots
 * and receives lobby/UI state only. It never learns where anything is.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  app: $('app'),
  status: $('status'),
  statusDot: $('statusDot'),
  you: $<HTMLButtonElement>('you'),
  youLabel: $('youLabel'),
  slot: $('slot'),
  stickZone: $('stickZone'),
  stickBase: $('stickBase'),
  stickKnob: $('stickKnob'),
  stickLabel: $('stickLabel'),
  btnA: $('btnA'),
  btnB: $('btnB'),
  btnC: $('btnC'),
  editHint: $('editHint'),
  sheet: $('sheet'),
  sheetPanel: $('sheetPanel'),
  sheetClose: $<HTMLButtonElement>('sheetClose'),
  nameInput: $<HTMLInputElement>('nameInput'),
  nameHint: $('nameHint'),
  colorGrid: $('colorGrid'),
  gameBanner: $('gameBanner'),
  gameTitle: $('gameTitle'),
  gameDetail: $('gameDetail'),
  coach: $('coach'),
  picker: $('picker'),
  gameList: $('gameList'),
  pickerHint: $('pickerHint'),
  rotateAnyway: $<HTMLButtonElement>('rotateAnyway'),
  overlay: $('overlay'),
  overlayTitle: $('overlayTitle'),
  overlayBody: $('overlayBody'),
  overlayAction: $('overlayAction'),
};

/* ------------------------------ room + token ----------------------------- */

/** Code comes from the URL: /brawl-games/j/ABCD */
function codeFromUrl(): string {
  const path = location.pathname;
  const i = path.indexOf(JOIN_PATH_PREFIX);
  if (i < 0) return '';
  return path.slice(i + JOIN_PATH_PREFIX.length).split('/')[0]!.toUpperCase();
}

const CODE = codeFromUrl();

/**
 * Token persistence.
 *
 * sessionStorage is the primary store — it is per-tab, so two people sharing
 * a phone in different tabs get different slots, which is correct.
 *
 * localStorage is a fallback read for the case sessionStorage cannot cover:
 * scanning the QR again opens a NEW tab, which starts with an empty
 * sessionStorage and would otherwise burn a fresh slot while the old one sits
 * in its grace window. Both writes happen once at join, so this costs two
 * string writes per session and nothing per frame.
 */
function loadToken(): string | undefined {
  const key = tokenStorageKey(CODE);
  try {
    const fromSession = sessionStorage.getItem(key);
    if (fromSession) return fromSession;
  } catch {
    /* private mode */
  }
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveToken(token: string): void {
  const key = tokenStorageKey(CODE);
  try {
    sessionStorage.setItem(key, token);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(key, token);
  } catch {
    /* ignore */
  }
}

function clearToken(): void {
  const key = tokenStorageKey(CODE);
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ------------------------------ game picker ------------------------------- */

/**
 * The lobby is the picker: tap a game and it starts.
 *
 * The catalogue comes from the HOST rather than being hard-coded here. This
 * page is a static file that a phone may have cached for a week, and a
 * controller that decides for itself what the games are will cheerfully offer
 * one the big screen has never heard of.
 */
let pickerKey = '';

function renderPicker(msg: {
  games: { id: string; name: string; tagline: string; lose: string }[];
  current: string;
  canPick: boolean;
}): void {
  el.picker.hidden = !msg.canPick;
  if (!msg.canPick) return;

  // Rebuild only when something visible changed. This message arrives a couple
  // of times a second and replacing the buttons under a thumb mid-tap loses
  // the tap.
  const key = `${msg.current}|${msg.games.map((g) => g.id).join(',')}`;
  if (key === pickerKey) return;
  pickerKey = key;

  el.gameList.replaceChildren(
    ...msg.games.map((g) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'game';
      b.setAttribute('aria-pressed', String(g.id === msg.current));

      const name = document.createElement('b');
      name.textContent = g.name;
      const tag = document.createElement('span');
      tag.textContent = g.tagline;
      const lose = document.createElement('i');
      lose.textContent = g.lose;
      b.append(name, tag, lose);

      b.addEventListener('click', () => {
        link.sendControl({ t: 'pick_game', id: g.id });
        // Hide immediately rather than waiting for the host to echo back. The
        // round is about to start and a picker still on screen over the
        // countdown reads as "the tap did not register".
        el.picker.hidden = true;
      });
      return b;
    }),
  );
}

/* ------------------------------- orientation ------------------------------ */

/**
 * Landscape is the intended grip, and the prompt is a request rather than a
 * gate.
 *
 * There is no reliable way to force it: `screen.orientation.lock()` requires
 * fullscreen, throws on desktop, and does not exist on iOS Safari at all. More
 * importantly, plenty of people play with the system rotation lock switched on
 * — for them the phone will NEVER turn, so a hard block would strand them on a
 * screen they cannot get past. Hence the escape hatch.
 */
const PORTRAIT_OK_KEY = 'brawl:portrait-ok';

try {
  if (sessionStorage.getItem(PORTRAIT_OK_KEY) === '1') el.app.classList.add('portrait-ok');
} catch {
  /* private mode; the prompt simply shows again */
}

el.rotateAnyway.addEventListener('click', () => {
  el.app.classList.add('portrait-ok');
  try {
    // Session, not local: a decision about how you are holding the phone right
    // now should not follow you into next week's game.
    sessionStorage.setItem(PORTRAIT_OK_KEY, '1');
  } catch {
    /* ignore */
  }
});

// Best effort, and expected to fail on most browsers. Wrapped because the sync
// throw on unsupported platforms would take the rest of startup with it.
try {
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (o: string) => Promise<void>;
  };
  void orientation?.lock?.('landscape').catch(() => {});
} catch {
  /* not available; the prompt covers it */
}

/* --------------------------------- coach --------------------------------- */

/**
 * The one-line "what am I supposed to do" prompt.
 *
 * Shown from the moment the phone connects and taken down a few seconds into
 * the first round the player is actually alive for — then never again. That
 * rule matters more than it looks:
 *
 *  - It covers the person who joins MID-ROUND. They sit out as a spectator
 *    until the next round, which is precisely the window in which they have
 *    nothing to do but read, and an earlier version hid the prompt from them
 *    for exactly that reason.
 *  - It does not reappear every round. By the third round a banner explaining
 *    the controls is noise sitting on top of the controls.
 *
 * Driven entirely off the phase the host already sends, so it needs no new
 * message and cannot drift out of sync with the game.
 */
const COACH_LINGER_MS = 4500;
let coachDone = false;
let coachTimer: ReturnType<typeof setTimeout> | null = null;

function clearCoachTimer(): void {
  if (coachTimer !== null) {
    clearTimeout(coachTimer);
    coachTimer = null;
  }
}

function updateCoach(phase: string, alive: boolean): void {
  if (coachDone) return;

  el.coach.hidden = false;
  el.coach.classList.remove('fading');

  // Only a round you are actually playing starts the countdown to retiring it.
  if (phase !== 'playing' || !alive) {
    clearCoachTimer();
    return;
  }
  if (coachTimer !== null) return;

  coachTimer = setTimeout(() => {
    coachDone = true;
    el.coach.classList.add('fading');
    coachTimer = setTimeout(() => {
      el.coach.hidden = true;
      coachTimer = null;
    }, 400);
  }, COACH_LINGER_MS);
}

/* -------------------------------- wiring --------------------------------- */

const stick = new Stick(el.stickZone, el.stickBase, el.stickKnob, el.stickLabel);
const buttons = new Buttons(el.btnA, el.btnB, el.btnC);
const link = new WsLink(wsUrlFor(WS_PATH), true);
const transport = new ControllerWsTransport(link);
const ticker = new InputTicker(transport, stick, buttons);
const wakeLock = new WakeLock();

const sheet = new CustomiseSheet({
  sheet: el.sheet,
  panel: el.sheetPanel,
  open: el.you,
  close: el.sheetClose,
  nameInput: el.nameInput,
  nameHint: el.nameHint,
  colorGrid: el.colorGrid,
});

let joined = false;

sheet.onChange = (patch) => {
  if (!joined) return;
  link.sendControl({ t: 'set_profile', ...patch });
};

sheet.onVisibility = (open) => {
  if (!open) return;
  // Drop every held touch when the sheet opens, so a thumb that was mid-drag
  // does not leave the character walking into a wall behind the panel.
  stick.reset();
  buttons.reset();
  if (link.isOpen && ticker.running) ticker.flushNeutral();
};

/* ------------------------------ touch input ------------------------------ *
 * Every handler walks `changedTouches` and dispatches by `identifier`.
 * Never `touches[0]` — with a thumb on the stick and a thumb on a button the
 * indices shuffle constantly, and index-based code produces a stick that
 * jumps to the button whenever the other thumb lifts.
 * ------------------------------------------------------------------------ */

function onTouchStart(event: TouchEvent): void {
  if (sheet.isOpen) return;
  for (const touch of Array.from(event.changedTouches)) {
    // Buttons first: they sit inside the right zone and are smaller targets.
    if (buttons.tryClaim(touch)) continue;
    stick.tryClaim(touch);
  }
  event.preventDefault();
}

function onTouchMove(event: TouchEvent): void {
  // The sheet is the one place scrolling is allowed, so bail before
  // preventDefault — otherwise the colour grid cannot be scrolled to.
  if (sheet.isOpen) return;
  for (const touch of Array.from(event.changedTouches)) {
    if (stick.owns(touch.identifier)) stick.move(touch);
    // Buttons intentionally ignore movement: sliding off a held button keeps
    // it held, which is how every physical gamepad behaves.
  }
  event.preventDefault();
}

function onTouchEnd(event: TouchEvent): void {
  if (sheet.isOpen) return;
  for (const touch of Array.from(event.changedTouches)) {
    stick.release(touch.identifier);
    buttons.release(touch.identifier);
  }
  event.preventDefault();
}

// Non-passive so preventDefault actually suppresses scroll/zoom gestures.
const opts: AddEventListenerOptions = { passive: false };
el.app.addEventListener('touchstart', onTouchStart, opts);
// move/end on window: a thumb that slides off the zone must keep tracking.
window.addEventListener('touchmove', onTouchMove, opts);
window.addEventListener('touchend', onTouchEnd, opts);
window.addEventListener('touchcancel', onTouchEnd, opts);

// Desktop dev convenience: WASD + J/K, so the host can be tested without a phone.
installKeyboardFallback();

/* -------------------------------- control -------------------------------- */

function setStatus(text: string, tone: 'ok' | 'warn' | 'bad'): void {
  el.status.textContent = text;
  el.statusDot.dataset.tone = tone;
}

function showOverlay(title: string, body: string, action?: { label: string; onTap: () => void }): void {
  el.overlayTitle.textContent = title;
  el.overlayBody.textContent = body;
  if (action) {
    el.overlayAction.textContent = action.label;
    el.overlayAction.hidden = false;
    el.overlayAction.onclick = action.onTap;
  } else {
    el.overlayAction.hidden = true;
  }
  el.overlay.hidden = false;
}

const hideOverlay = (): void => {
  el.overlay.hidden = true;
};

/** Paint the profile the server says is in effect. Never applied optimistically. */
function applyProfile(profile: { name: string; color: string; colorName: string }): void {
  document.documentElement.style.setProperty('--player', profile.color);
  el.youLabel.textContent = profile.name
    ? profile.name.toUpperCase()
    : `YOU ARE ${profile.colorName}`;
  sheet.setProfile({ name: profile.name, color: profile.color });
}

function onControl(msg: ControlMessage): void {
  switch (msg.t) {
    case 'joined': {
      joined = true;
      saveToken(msg.token);
      hideOverlay();

      el.slot.textContent = defaultName(msg.slot);
      el.editHint.hidden = false;
      setStatus(msg.resumed ? 'reconnected' : 'connected', 'ok');

      sheet.setOwnSlot(msg.slot);
      sheet.setTaken(msg.taken);
      applyProfile(msg);

      ticker.start();
      void wakeLock.acquire();

      // Reuse the name from a previous room, if this player has played
      // before. Sent after joining, so it never delays getting in.
      if (!msg.resumed && !msg.name) {
        const prefs = loadPreferences();
        if (prefs) link.sendControl({ t: 'set_profile', name: prefs.name });
      }
      return;
    }

    case 'profile': {
      applyProfile(msg);
      savePreferences({ name: msg.name });
      if (msg.error) sheet.showError(msg.error);
      return;
    }

    case 'game_ui': {
      // UI status only — a banner and whether the controls read as live. The
      // phone still has no idea where anything is; it is a gamepad.
      const showBanner = msg.phase !== 'playing';
      el.gameBanner.hidden = !showBanner;
      el.gameTitle.textContent = msg.title;
      el.gameTitle.classList.toggle('count', msg.phase === 'countdown');
      el.gameDetail.textContent = msg.detail;
      el.app.classList.toggle('out', !msg.youAlive);
      updateCoach(msg.phase, msg.youAlive);
      return;
    }

    case 'game_menu':
      renderPicker(msg);
      return;

    case 'lobby':
      // The only state a phone ever gets. No positions, no scores.
      setStatus(`connected · ${msg.playerCount} playing`, 'ok');
      // Put the prompt up as soon as we are in a room, rather than waiting for
      // the first game_ui — the host may still be loading the 3D engine, and
      // that wait is the best possible moment to read one line of instructions.
      updateCoach('lobby', false);
      // Keeps an open colour picker honest as people join, leave or recolour.
      sheet.setTaken(msg.taken);
      return;

    case 'join_error': {
      joined = false;
      ticker.stop();
      // A stale token pointing at a dead room must not wedge us in a retry
      // loop — drop it so the next attempt joins fresh.
      if (msg.reason === 'no_room') clearToken();
      showOverlay(
        msg.reason === 'room_full' ? 'Room is full' : 'Room not found',
        msg.reason === 'room_full'
          ? 'All four slots are taken. Try again when someone drops out.'
          : 'That game has ended. Scan the code on the big screen again.',
        { label: 'Retry', onTap: () => location.reload() },
      );
      return;
    }

    case 'host_gone':
      joined = false;
      ticker.stop();
      showOverlay('Game ended', 'The big screen disconnected.', {
        label: 'Retry',
        onTap: () => location.reload(),
      });
      return;

    default:
      return;
  }
}

link.onControl(onControl);

link.onOpen(() => {
  setStatus(joined ? 'reconnecting…' : 'joining…', 'warn');
  const token = loadToken();
  link.sendControl(token ? { t: 'join', code: CODE, token } : { t: 'join', code: CODE });
});

link.onClosed(({ willRetry }) => {
  ticker.stop();
  if (willRetry) setStatus('reconnecting…', 'warn');
  else setStatus('disconnected', 'bad');
});

/* ----------------------------- app lifecycle ----------------------------- */

const detachWakeLock = wakeLock.attach();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // Drop every held touch and tell the host to stop the character. Without
    // this the last non-zero axes stand for the full silence timeout and the
    // circle keeps sliding after the player has switched apps.
    stick.reset();
    buttons.reset();
    if (link.isOpen) ticker.flushNeutral();
    ticker.stop();
    return;
  }

  // Back in the foreground: reconnect now rather than waiting out the backoff,
  // and resume sending only once the join is re-acknowledged.
  link.poke();
  if (joined && link.isOpen) ticker.start();
});

window.addEventListener('pagehide', () => {
  ticker.stop();
  void wakeLock.release();
  detachWakeLock();
});

/* --------------------------------- boot ---------------------------------- */

if (!CODE || CODE.length !== 4) {
  showOverlay('No room code', 'Scan the QR code on the big screen to join.');
} else {
  setStatus('connecting…', 'warn');
  // transport.connect() attaches to the link and opens it if nobody has yet.
  // WsLink.connect() is idempotent, so the ordering here does not matter.
  void transport.connect();
}

/* ------------------------------ dev fallback ----------------------------- */

function installKeyboardFallback(): void {
  // Only useful on a desktop browser; harmless on a phone.
  if (matchMedia('(pointer: coarse)').matches) return;

  const held = new Set<string>();
  const axis = (): void => {
    stick.x = (held.has('d') ? 1 : 0) - (held.has('a') ? 1 : 0);
    stick.y = (held.has('s') ? 1 : 0) - (held.has('w') ? 1 : 0);
  };

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (held.has(k)) return;
    held.add(k);
    if (k === 'j') el.btnA.dispatchEvent(new Event('devpress'));
    if (k === 'k') el.btnB.dispatchEvent(new Event('devpress'));
    if (k === 'l') el.btnC.dispatchEvent(new Event('devpress'));
    axis();
  });
  addEventListener('keyup', (e) => {
    held.delete(e.key.toLowerCase());
    axis();
  });

  // Reuse the real click path so the counter logic stays single-sourced.
  for (const [el2, key] of [
    [el.btnA, 'j'],
    [el.btnB, 'k'],
    [el.btnC, 'l'],
  ] as const) {
    el2.addEventListener('devpress', () => {
      const fake = { identifier: key === 'j' ? -101 : key === 'k' ? -102 : -103, clientX: 0, clientY: 0 } as Touch;
      // Bypass hit testing for the synthetic press.
      const rect = el2.getBoundingClientRect();
      Object.assign(fake, {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      });
      buttons.tryClaim(fake);
      setTimeout(() => buttons.release(fake.identifier), 80);
    });
  }
}
