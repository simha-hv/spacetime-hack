/**
 * Shared constants. Zero runtime dependencies — this file is imported by the
 * server (node), the host (browser) and the controller (browser).
 */

/** The one port everything is served from. nginx proxies /brawl-games/ here. */
export const PORT = 1099;

/**
 * Base path. nginx uses `proxy_pass http://localhost:1099;` with NO URI part,
 * so the original request path arrives here *including* this prefix.
 */
export const BASE_PATH = '/brawl-games';

/** WebSocket endpoint (control channel +, for now, the input channel). */
export const WS_PATH = `${BASE_PATH}/ws`;

/** Controller join URL shape: <origin>/brawl-games/j/ABCD */
export const JOIN_PATH_PREFIX = `${BASE_PATH}/j/`;

/** Controller input sample rate. Fixed cadence, NOT event-driven. */
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

export const MAX_PLAYERS = 4;

/** Room code alphabet: 32 chars, no O/0/I/1. 32^4 = 1,048,576 codes. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

/* Colours live in profile.ts — they are player identity, not
   wiring, and the server, host and phone all validate against the same list. */

/** All durations in milliseconds. */
export const TIMING = {
  /** Controller input tick. */
  inputTickMs: TICK_MS,
  /** Host zeroes a slot's axes after this long with no accepted frame. */
  inputSilenceMs: 500,
  /** Control-channel keepalive. Also keeps the AWS ALB from reaping the socket. */
  pingIntervalMs: 5_000,
  /** No pong within this window -> treat the socket as dead. */
  pingTimeoutMs: 15_000,
  /** A disconnected player keeps their slot + colour this long. The single
   *  most important number in the file: it is what makes "got a text, came
   *  back" reclaim the same character instead of joining as someone new. */
  slotGraceMs: 45_000,
  /** Room dies this long after the host goes away. */
  hostGraceMs: 60_000,
  /** Room dies after this long with no traffic at all. */
  idleRoomMs: 600_000,
  /** How often the registry sweeps for expired rooms/slots. */
  sweepIntervalMs: 5_000,
  /** Controller reconnect backoff. */
  reconnectMinMs: 250,
  reconnectMaxMs: 5_000,
} as const;

/** Storage keys (scoped per room code so two rooms don't collide). */
export const tokenStorageKey = (code: string) => `brawl:tok:${code.toUpperCase()}`;

/**
 * Name preference, remembered across rooms and sessions.
 *
 * Not the colour: which colours are free depends on who else is in the room,
 * so that is decided per room at join time.
 */
export const PROFILE_STORAGE_KEY = 'brawl:profile';
