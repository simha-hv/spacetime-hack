/**
 * The node-safe surface of the game.
 *
 * This is what the test build bundles, so everything reachable from here must
 * run without a DOM or a GPU. That rules out `Match` (it builds sprites from a
 * 2D canvas and needs a WebGL context) and `Hud` (pure DOM), but crucially NOT
 * the physics: three's math and scene graph are plain objects, and Rapier's
 * WASM loads fine under node.
 *
 * That matters more than it sounds. The tests drive the REAL `Fighter` against
 * the REAL `Level` with the same gravity, gains and impulses the big screen
 * runs — so a regression in the upright torque or in whether the parapet
 * actually holds anyone in is caught here rather than on a TV.
 */

export { blendPose, buildAnimal, POSES, SPECIES } from './animal.js';
export type { Animal, AnimalJoints, Species, SpeciesId } from './animal.js';
export { ChaseCamera } from './camera.js';
export { stickToMove } from './controls.js';
export { loadRapier, STEP_MS } from './engine.js';
export { Fighter } from './fighter.js';
export type { FighterEvents, FighterInput, FighterState } from './fighter.js';
// `standingsKey` is pure; the Hud class it lives with never runs under node.
export { standingsKey } from './hud.js';
export { Juice } from './juice.js';
export type { Arena, ArenaCtx } from './arena.js';
export { Cpu } from './cpu.js';
export { DEFAULT_GAME, GAMES, gameById } from './games.js';
export type { GameDef, GameId } from './games.js';
export type { CpuView } from './cpu.js';
export { DECK_X, DECK_Z, GAP, KILL_Y, PARAPET_T, RooftopArena } from './levels/rooftop.js';
export { GrinderArena } from './levels/grinder.js';
export { PitArena } from './levels/dojo.js';
