/**
 * Control-channel messages. JSON, sent as WebSocket *text* frames.
 * (Binary frames on the same socket are input datagrams — see input.ts.)
 *
 * The server understands joining, slots, colours, tokens and expiry.
 * It does not understand the game. It never inspects an input datagram
 * beyond prepending a slot byte.
 */

export interface PlayerInfo {
  slot: number;
  color: string;
  colorName: string;
  /** Sanitized display name, or '' if the player has not set one. */
  name: string;
  /** False while the player is inside their disconnect grace window. */
  connected: boolean;
}

/** Which colours are spoken for, so a phone can grey them out in the picker. */
export interface ColorClaim {
  color: string;
  slot: number;
}

/* ----------------------------- host -> server ---------------------------- */

export interface HostHello {
  t: 'host_hello';
  /** Reclaim an existing room after a host page reload. */
  resume?: string;
}

/* ----------------------------- server -> host ---------------------------- */

export interface HostWelcome {
  t: 'host_welcome';
  code: string;
  /** Opaque; lets the host reclaim this room across a reload. */
  hostToken: string;
  /** Full absolute URL to put in the QR code. */
  joinUrl: string;
  tickHz: number;
  /** Current occupancy, so a resuming host repaints immediately. */
  players: PlayerInfo[];
}

export interface PlayerJoin {
  t: 'player_join';
  slot: number;
  color: string;
  colorName: string;
  name: string;
  /** True when this is a returning player reclaiming their slot. */
  resumed: boolean;
}

/** A player changed their name or colour mid-game. */
export interface PlayerProfile {
  t: 'player_profile';
  slot: number;
  color: string;
  colorName: string;
  name: string;
}

export interface PlayerLeave {
  t: 'player_leave';
  slot: number;
  reason: 'closed' | 'timeout';
}

/** Player's socket dropped but the slot is being held through the grace window. */
export interface PlayerStale {
  t: 'player_stale';
  slot: number;
}

export interface Roster {
  t: 'roster';
  players: PlayerInfo[];
}

/* -------------------------- controller -> server -------------------------- */

export interface Join {
  t: 'join';
  code: string;
  /** Token from a previous join; reclaims the same slot and colour. */
  token?: string;
}

/**
 * Set name and/or colour. Sent after joining, never before — a player
 * is already in the game by the time they can open the picker.
 *
 * Omitted fields are left unchanged. The server is authoritative: it sanitizes
 * the name and rejects a colour another player already holds.
 */
export interface SetProfile {
  t: 'set_profile';
  name?: string;
  color?: string;
}

/* -------------------------- server -> controller -------------------------- */

export interface Joined {
  t: 'joined';
  slot: number;
  color: string;
  colorName: string;
  name: string;
  /** Persist this. It is what makes the reclaim work. */
  token: string;
  resumed: boolean;
  tickHz: number;
  code: string;
  /** Colours held by everyone, including this player. */
  taken: ColorClaim[];
}

/**
 * The server's answer to a `set_profile`. Always carries the values that are
 * now in effect, so a rejected colour leaves the phone showing the truth
 * rather than an optimistic guess.
 */
export interface Profile {
  t: 'profile';
  color: string;
  colorName: string;
  name: string;
  /** Set when part of the request could not be applied. */
  error?: 'color_taken' | 'bad_color' | 'bad_name';
}

export interface JoinError {
  t: 'join_error';
  reason: 'bad_code' | 'no_room' | 'room_full';
}

/**
 * The ONLY state a phone ever receives. Lobby/UI, never game state:
 * no positions, no scores, no simulation. The phone is a gamepad.
 */
export interface Lobby {
  t: 'lobby';
  slot: number;
  color: string;
  colorName: string;
  playerCount: number;
  /** Live colour availability, so open pickers update as people join, leave
   *  or recolour. Lobby/UI state only — still nothing about the simulation. */
  taken: ColorClaim[];
}

export interface HostGone {
  t: 'host_gone';
}

/**
 * Game status for one player's phone. Host -> server -> that one controller;
 * the server forwards it blindly, exactly like the RTC signaling messages, and
 * never looks inside.
 *
 * This is the closest thing to a boundary case in the whole protocol, so to be
 * explicit: it is UI status, NOT game state. There are no positions, no
 * velocities, nothing simulated and nothing renderable. The phone uses it to
 * show a banner and dim its buttons while you are out. It remains a gamepad
 * and still could not draw the game if it wanted to.
 */
export interface GameUi {
  t: 'game_ui';
  /** Host -> server: which slot this is for. Server -> phone: echoed. */
  slot: number;
  phase: 'lobby' | 'countdown' | 'playing' | 'out' | 'round_over';
  /** Big line, e.g. "SPIN OUT" or "WINNER". */
  title: string;
  /** Small line, e.g. "jump the low bar" or "3rd · 42s". */
  detail: string;
  /** False once this player has fallen; the phone dims its controls. */
  youAlive: boolean;
  /** Countdown seconds, when the phase has one. */
  secondsLeft?: number;
}

/**
 * Host -> every phone: what is playable, and what is selected right now.
 *
 * Sent on join and whenever the selection changes. The catalogue lives on the
 * HOST — the controller is a static HTML file that may have been cached for a
 * week, and a phone that decides for itself what the games are will happily
 * offer one the big screen has never heard of.
 */
export interface GameMenu {
  t: 'game_menu';
  /** Host -> server: which slot. Server -> phone: echoed. */
  slot: number;
  games: { id: string; name: string; tagline: string; lose: string }[];
  /** The id currently selected. */
  current: string;
  /** False while a round is running, when the picker must not act. */
  canPick: boolean;
}

/**
 * Phone -> host: play this one.
 *
 * There is no vote and no majority. Whoever taps first picks, and the round
 * starts — a party game that makes four people agree before anything happens is
 * a party game nobody plays twice.
 */
export interface PickGame {
  t: 'pick_game';
  id: string;
  /** Server -> host: stamped with the sender's slot. Phones do not set it. */
  slot?: number;
}

/* -------------------------------- both ---------------------------------- */

export interface Ping {
  t: 'ping';
  ts: number;
}
export interface Pong {
  t: 'pong';
  ts: number;
}

/* --------------------- reserved: WebRTC signaling ------------------------ *
 * Not implemented this milestone. The server will relay these blindly
 * between a host and one slot without parsing `data`. Declared now so the
 * swap is additive rather than a protocol break.
 * ------------------------------------------------------------------------ */

export interface RtcSignal {
  t: 'rtc_offer' | 'rtc_answer' | 'rtc_ice';
  slot: number;
  data: unknown;
}

/* ------------------------------- unions --------------------------------- */

export type ClientToServer =
  | HostHello
  | Join
  | SetProfile
  | GameUi
  | GameMenu
  | PickGame
  | Ping
  | Pong
  | RtcSignal;

export type ServerToClient =
  | HostWelcome
  | PlayerJoin
  | PlayerProfile
  | PlayerLeave
  | PlayerStale
  | Roster
  | Joined
  | JoinError
  | Profile
  | Lobby
  | GameUi
  | GameMenu
  | PickGame
  | HostGone
  | Ping
  | Pong
  | RtcSignal;

export type ControlMessage = ClientToServer | ServerToClient;

/** Parse a text frame into a control message, or null if it is not one. */
export function parseControl(raw: string): ControlMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const t = (value as { t?: unknown }).t;
  if (typeof t !== 'string' || t.length === 0) return null;
  return value as ControlMessage;
}

export const encodeControl = (msg: ControlMessage): string => JSON.stringify(msg);
