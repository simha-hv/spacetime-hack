import type { Arena } from './arena.js';
import { GrinderArena } from './levels/grinder.js';
import { PitArena } from './levels/dojo.js';
import { RooftopArena } from './levels/rooftop.js';

/**
 * The catalogue.
 *
 * Three games that differ in the one thing that actually changes how a brawler
 * plays: **how you win**.
 *
 *   KNOCKOUT  position   put them over an edge
 *   GRINDER   the level   let the machinery do it
 *   THE PIT   damage      take their health bar
 *
 * Everything else — the animals, the physics, the punch, the grab, the phones,
 * the CPUs — is shared. That is deliberate: a player learns one control scheme
 * once and every game is immediately playable, which is the whole point of a
 * party game where someone joins halfway through the evening.
 *
 * A game with `health: null` has no health system at all; you are out when you
 * are below the arena's kill plane and not before. A game with a number has no
 * meaningful way to fall, so health is the only way out.
 */
export interface GameDef {
  id: GameId;
  name: string;
  /** One line, shown on the phone's picker and the big screen. */
  tagline: string;
  /** How you lose, in four or five words. Shown under the tagline. */
  lose: string;
  /** Starting health, or null for a pure ring-out game. */
  health: number | null;
  /** Damage per landed punch. Ignored when `health` is null. */
  punchDamage: number;
  /** Damage from being thrown. Bigger, because a throw is harder to land. */
  throwDamage: number;
  /** Hard stop, so a stalemate cannot run forever. */
  roundLimitMs: number;
  createArena(): Arena;
}

export type GameId = 'knockout' | 'grinder' | 'pit';

export const GAMES: readonly GameDef[] = [
  {
    id: 'knockout',
    name: 'KNOCKOUT',
    tagline: 'Rooftop brawl',
    lose: 'Fall off the roof',
    health: null,
    punchDamage: 0,
    throwDamage: 0,
    roundLimitMs: 100_000,
    createArena: () => new RooftopArena(),
  },
  {
    id: 'grinder',
    name: 'GRINDER',
    tagline: 'The floor is moving',
    lose: 'Ride the belt into the pit',
    health: null,
    punchDamage: 0,
    throwDamage: 0,
    // Shorter: the belts are always pushing someone toward the edge, so a
    // round that has not resolved in a minute is two people hiding on the ledge.
    roundLimitMs: 70_000,
    createArena: () => new GrinderArena(),
  },
  {
    id: 'pit',
    name: 'THE PIT',
    tagline: 'Last one standing',
    lose: 'Lose all your health',
    health: 100,
    // Roughly seven clean punches, or four throws. Long enough that one lucky
    // opening does not decide it, short enough that a round is not a war of
    // attrition nobody is watching by the end.
    punchDamage: 14,
    throwDamage: 26,
    roundLimitMs: 90_000,
    createArena: () => new PitArena(),
  },
];

export const DEFAULT_GAME: GameId = 'knockout';

export function gameById(id: string): GameDef {
  return GAMES.find((g) => g.id === id) ?? GAMES.find((g) => g.id === DEFAULT_GAME)!;
}
