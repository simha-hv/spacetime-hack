import type { SafeZone } from './arena.js';
import type { FighterInput } from './fighter.js';

/**
 * A CPU brawler.
 *
 * Produces the same `FighterInput` a phone does — axes and press counts — and
 * nothing else. It has no privileged access to the simulation and no special
 * physics: it is a bot holding a gamepad, which is what keeps it honest. If the
 * CPU can do something a player cannot, that is a bug.
 *
 * The behaviour it needs, in priority order:
 *
 *   1. DO NOT WALK OFF. This dominates everything. A bot that beelines at its
 *      target strolls straight out of a parapet gap within a few seconds and
 *      the round is over before anyone has thrown a punch — which is exactly
 *      what the first four scripted test bots did, every single run.
 *   2. Close on the nearest live opponent.
 *   3. Hit them, and prefer hitting them toward the nearest gap.
 *
 * It is deliberately beatable: it reacts on a delay, it hesitates, and it aims
 * roughly rather than perfectly.
 */

export interface CpuView {
  x: number;
  y: number;
  z: number;
  alive: boolean;
}

/** How close to the edge before self-preservation overrides everything. */
const DANGER_MARGIN = 1.5;
/** Inside this, the bot is committed to steering back and ignores its target. */
const PANIC_MARGIN = 0.55;

const PUNCH_RANGE = 1.6;
const GRAB_RANGE = 1.4;

/** Reaction delay, so it does not punch on the exact frame you enter range. */
const REACT_MS = 150;
const PUNCH_COOLDOWN_MS = 620;
const GRAB_COOLDOWN_MS = 2600;


export class Cpu {
  private reactMs = 0;
  private punchCooldownMs = 0;
  private grabCooldownMs = 0;
  private holdingSince = -1;
  /** Slow random walk so two bots do not mirror each other exactly. */
  private wanderPhase = Math.random() * Math.PI * 2;

  constructor(private readonly seed = Math.random()) {
    this.wanderPhase = seed * Math.PI * 2;
  }

  /**
   * `self` is this bot's body, `peers` every other live fighter.
   * `holding` is true while it has someone picked up.
   */
  think(
    self: CpuView,
    peers: readonly CpuView[],
    holding: boolean,
    dtMs: number,
    safe: SafeZone | null,
  ): FighterInput {
    this.punchCooldownMs = Math.max(0, this.punchCooldownMs - dtMs);
    this.grabCooldownMs = Math.max(0, this.grabCooldownMs - dtMs);
    this.wanderPhase += dtMs * 0.0006;

    const idle: FighterInput = { moveX: 0, moveZ: 0, punches: 0, grabs: 0, jumps: 0 };

    // Already falling: nothing useful left to do.
    if (self.y < -1) return idle;

    const target = nearest(self, peers);

    /* ------------------------- 1. stay on the roof ------------------------ */

    // Push away from whichever edges are close. Each of the four independently,
    // so a corner produces a diagonal escape rather than a stalemate — and so
    // an arena that is only dangerous on one side (the grinder's pit) does not
    // make the bot cower in the middle.
    let escapeX = 0;
    let escapeZ = 0;
    let danger = 0;
    let panicking = false;

    if (safe) {
      const push = (over: number, dir: number, axis: 'x' | 'z'): void => {
        if (over <= 0) return;
        if (axis === 'x') escapeX += dir;
        else escapeZ += dir;
        danger = Math.max(danger, over / DANGER_MARGIN);
        if (over > DANGER_MARGIN - PANIC_MARGIN) panicking = true;
      };
      push(self.x - (safe.maxX - DANGER_MARGIN), -1, 'x');
      push(safe.minX + DANGER_MARGIN - self.x, 1, 'x');
      push(self.z - (safe.maxZ - DANGER_MARGIN), -1, 'z');
      push(safe.minZ + DANGER_MARGIN - self.z, 1, 'z');
    }

    // Right at the brink, steering home is the ONLY thing that matters.
    if (panicking) {
      const len = Math.hypot(escapeX, escapeZ) || 1;
      return { ...idle, moveX: escapeX / len, moveZ: escapeZ / len };
    }

    /* ---------------------------- 2. close in ----------------------------- */

    if (!target) {
      // Nobody to fight: drift toward the middle rather than standing on a ledge.
      return {
        ...idle,
        moveX: -self.x * 0.14 + Math.cos(this.wanderPhase) * 0.2,
        moveZ: -self.z * 0.14 + Math.sin(this.wanderPhase) * 0.2,
      };
    }

    const dx = target.x - self.x;
    const dz = target.z - self.z;
    const dist = Math.hypot(dx, dz);

    let wantX = dist > 0.01 ? dx / dist : 0;
    let wantZ = dist > 0.01 ? dz / dist : 0;

    // Back off slightly when already on top of them, so the bot does not just
    // bulldoze people (and itself) over the edge without ever swinging.
    if (dist < PUNCH_RANGE * 0.6) {
      wantX *= -0.35;
      wantZ *= -0.35;
    }

    // Blend in the escape vector. `danger` rises as the edge approaches, so the
    // bot arcs around the rim after a target instead of following it off.
    const w = Math.min(1, danger);
    let moveX = wantX * (1 - w) + escapeX * w;
    let moveZ = wantZ * (1 - w) + escapeZ * w;

    // A little wobble so two bots chasing the same person do not overlap
    // perfectly and look like one character.
    moveX += Math.cos(this.wanderPhase * 1.7) * 0.12;
    moveZ += Math.sin(this.wanderPhase * 1.3) * 0.12;

    const len = Math.hypot(moveX, moveZ);
    if (len > 1) {
      moveX /= len;
      moveZ /= len;
    }

    /* ----------------------------- 3. attack ------------------------------ */

    let punches = 0;
    let grabs = 0;

    if (holding) {
      // Hold them for a beat, then throw — a bot that throws on the very next
      // frame reads as a glitch rather than a decision.
      if (this.holdingSince < 0) this.holdingSince = 0;
      this.holdingSince += dtMs;
      if (this.holdingSince > 380) {
        grabs = 1;
        this.holdingSince = -1;
        this.grabCooldownMs = GRAB_COOLDOWN_MS;
      }
      // While carrying, walk toward the nearest lethal edge to dump them over
      // it. With no such edge (an enclosed arena) just keep hold and throw.
      const toEdgeZ = safe ? (self.z > (safe.minZ + safe.maxZ) / 2 ? 1 : -1) : 0;
      return { ...idle, moveX: moveX * 0.4, moveZ: toEdgeZ * 0.7, grabs };
    }
    this.holdingSince = -1;

    const inRange = dist < PUNCH_RANGE;
    if (inRange) {
      this.reactMs += dtMs;
    } else {
      this.reactMs = 0;
    }

    if (this.reactMs > REACT_MS) {
      if (dist < GRAB_RANGE && this.grabCooldownMs === 0 && this.seed > 0.5) {
        grabs = 1;
        this.grabCooldownMs = GRAB_COOLDOWN_MS;
      } else if (this.punchCooldownMs === 0) {
        punches = 1;
        this.punchCooldownMs = PUNCH_COOLDOWN_MS;
      }
    }

    return { moveX, moveZ, punches, grabs, jumps: 0 };
  }
}

function nearest(self: CpuView, peers: readonly CpuView[]): CpuView | null {
  let best: CpuView | null = null;
  let bestDist = Infinity;
  for (const p of peers) {
    if (!p.alive || p === self) continue;
    const d = Math.hypot(p.x - self.x, p.z - self.z);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}
