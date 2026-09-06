import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  blendPose,
  buildAnimal,
  ChaseCamera,
  Cpu,
  DECK_X,
  DECK_Z,
  Fighter,
  GAMES,
  gameById,
  GrinderArena,
  KILL_Y,
  PitArena,
  RooftopArena,
  loadRapier,
  POSES,
  SPECIES,
  standingsKey,
  STEP_MS,
  stickToMove,
} from '../../../dist/test/game.js';

/**
 * These drive the REAL fighter on the REAL level under the REAL Rapier world —
 * same gravity, same gains, same impulses the big screen runs. Nothing here is
 * a model of the physics; it is the physics.
 *
 * That is deliberate. The two worst bugs in this game so far were a sign error
 * in the upright torque (which parked everyone on their heads) and a missing
 * `ActiveEvents` flag (which made every collision silently do nothing). Neither
 * is visible in a unit test of a pure function, and both are caught below.
 */

let RAPIER;
let THREEScene;

before(async () => {
  RAPIER = await loadRapier();
  // three is bundled in, but the Level only needs somewhere to put meshes.
  const { Scene } = await import('three');
  THREEScene = Scene;
});

const NO_EVENTS = {
  onPunchThrown() {},
  onHit() {},
  onGrab() {},
  onThrow() {},
  onLand() {},
};

/** The rooftop's own safe rectangle, for the pure CPU-steering tests. */
const ROOF_SAFE = new RooftopArena().safeZone();

const IDLE = { moveX: 0, moveZ: 0, punches: 0, grabs: 0, jumps: 0 };

/** A world with an arena in it, plus a teardown. Defaults to the rooftop. */
function makeArena(make = () => new RooftopArena()) {
  const world = new RAPIER.World({ x: 0, y: -22.5, z: 0 });
  const scene = new THREEScene();
  const level = make();
  level.build({ rapier: RAPIER, world, scene });
  const fighters = [];

  return {
    world,
    level,
    fighters,
    spawn(x, z, slot = fighters.length) {
      const species = SPECIES[slot % SPECIES.length];
      const f = new Fighter(RAPIER, world, slot, species.id, '#ff8a3d', species.bulk, { x, z });
      fighters.push(f);
      return f;
    },
    /** Step every fighter and the world for `ms`, feeding each an input. */
    run(ms, inputFor = () => IDLE) {
      const steps = Math.round(ms / STEP_MS);
      for (let i = 0; i < steps; i++) {
        for (const f of fighters) {
          f.captureTransform();
          f.step(STEP_MS, inputFor(f, i), fighters, NO_EVENTS);
        }
        world.step();
        for (const f of fighters) f.checkFall(level.killY);
      }
    },
    free() {
      world.free();
    },
  };
}

/** World-space up vector of a body, for asking "is this thing standing?". */
function upOf(fighter) {
  const q = fighter.body.rotation();
  return {
    x: 2 * (q.x * q.y - q.w * q.z),
    y: 1 - 2 * (q.x * q.x + q.z * q.z),
    z: 2 * (q.y * q.z + q.w * q.x),
  };
}

/* -------------------------------------------------------------------------- */

describe('standing up', () => {
  let arena;
  after(() => arena?.free());

  it('settles upright when simply dropped', () => {
    arena = makeArena();
    const f = arena.spawn(0, 0);
    arena.run(1500);

    assert.ok(upOf(f).y > 0.97, `expected to be standing, up.y = ${upOf(f).y}`);
    assert.ok(f.position.y > 0, 'should be resting on the deck, not through it');
  });
});

describe('the upright torque', () => {
  let arena;
  after(() => arena?.free());

  /**
   * The regression test for the sign error.
   *
   * `cross(up, worldUp)` is (-up.z, 0, up.x). With the negation of that the
   * torque drives the body AWAY from vertical, and a fighter tipped over stays
   * over — chattering on its head rather than obviously flipping, which is why
   * it read as a stuck ragdoll for so long.
   */
  it('rights a fighter that has been knocked flat', () => {
    arena = makeArena();
    const f = arena.spawn(0, 0);
    arena.run(600);

    // Tip it 80° onto its side.
    const a = (80 * Math.PI) / 180;
    f.body.setRotation({ x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) }, true);
    f.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    assert.ok(upOf(f).y < 0.2, 'precondition: should start nearly flat');

    arena.run(2000);
    assert.ok(upOf(f).y > 0.9, `expected to have got back up, up.y = ${upOf(f).y}`);
  });

  it('does not fight the fall while stunned', () => {
    const solo = makeArena();
    try {
      const f = solo.spawn(0, 0);
      solo.run(600);
      f.takeHit(1, 0, 12, 4);
      assert.equal(f.state, 'stunned');
      // 300ms in, still mid-stun, the body should be off vertical rather than
      // snapping back — the stagger is the whole point.
      solo.run(300);
      assert.ok(upOf(f).y < 0.95, `expected to be reeling, up.y = ${upOf(f).y}`);
    } finally {
      solo.free();
    }
  });
});

describe('the level', () => {
  let arena;
  after(() => arena?.free());

  it('spawns everyone on the deck, inside the parapet', () => {
    arena = makeArena();
    for (const p of arena.level.spawnPoints()) {
      assert.ok(Math.abs(p.x) < DECK_X - 1, `spawn x ${p.x} is outside the deck`);
      assert.ok(Math.abs(p.z) < DECK_Z - 1, `spawn z ${p.z} is outside the deck`);
    }
    assert.equal(new Set(arena.level.spawnPoints().map((p) => `${p.x},${p.z}`)).size, 4);
  });

  it('holds a player in against the solid east wall', () => {
    const solo = makeArena();
    try {
      const f = solo.spawn(0, 0);
      solo.run(2600, () => ({ ...IDLE, moveX: 1 }));
      assert.equal(f.state !== 'out', true, 'ran straight through the east parapet');
      assert.ok(f.position.x < DECK_X, `ended at x = ${f.position.x}, past the deck edge`);
    } finally {
      solo.free();
    }
  });

  /**
   * The gaps ARE the game. A rooftop with a wall all the way round has no
   * elimination at all, which is exactly as broken as one with no wall.
   */
  it('lets a player run off through the south gap', () => {
    const solo = makeArena();
    try {
      const f = solo.spawn(0, 3.0);
      solo.run(3000, () => ({ ...IDLE, moveZ: 1 }));
      assert.equal(f.state, 'out', `still alive at z = ${f.position.z}`);
    } finally {
      solo.free();
    }
  });

  it('eliminates anyone who falls below the kill plane', () => {
    const solo = makeArena();
    try {
      const f = solo.spawn(0, 0);
      f.body.setTranslation({ x: 0, y: KILL_Y - 1, z: 0 }, true);
      assert.equal(f.checkFall(KILL_Y), true);
      assert.equal(f.alive, false);
      // And only once, so a score is never awarded twice for the same fall.
      assert.equal(f.checkFall(KILL_Y), false);
    } finally {
      solo.free();
    }
  });

  it('puts the crates back on reset', () => {
    const solo = makeArena();
    try {
      const crate = solo.level.props[0];
      crate.body.setTranslation({ x: 40, y: -80, z: 40 }, true);
      solo.level.reset();
      const t = crate.body.translation();
      assert.ok(Math.hypot(t.x - crate.home.x, t.y - crate.home.y, t.z - crate.home.z) < 1e-6);
      assert.equal(crate.mesh.visible, true);
    } finally {
      solo.free();
    }
  });
});

describe('punching', () => {
  it('knocks a target backwards and stuns it', () => {
    const arena = makeArena();
    try {
      const a = arena.spawn(0, 0, 0);
      const b = arena.spawn(0, 1.1, 1);
      arena.run(700);

      a.facing = 0; // +Z, straight at b
      const before = b.position.z;
      // One press, then let it play out through windup and the active window.
      arena.run(400, (f, i) => (f === a && i === 0 ? { ...IDLE, punches: 1 } : IDLE));

      assert.ok(b.position.z > before + 0.4, `b barely moved: ${before} -> ${b.position.z}`);
      assert.notEqual(b.state, 'up');
    } finally {
      arena.free();
    }
  });

  it('misses someone standing behind you', () => {
    const arena = makeArena();
    try {
      const a = arena.spawn(0, 0, 0);
      const b = arena.spawn(0, -1.1, 1);
      arena.run(700);

      a.facing = 0; // facing +Z, away from b
      arena.run(400, (f, i) => (f === a && i === 0 ? { ...IDLE, punches: 1 } : IDLE));
      assert.equal(b.state, 'up', 'punched through the back of your own head');
    } finally {
      arena.free();
    }
  });

  it('misses someone out of range', () => {
    const arena = makeArena();
    try {
      const a = arena.spawn(0, 0, 0);
      const b = arena.spawn(0, 3.4, 1);
      arena.run(700);
      a.facing = 0;
      arena.run(400, (f, i) => (f === a && i === 0 ? { ...IDLE, punches: 1 } : IDLE));
      assert.equal(b.state, 'up');
    } finally {
      arena.free();
    }
  });

  it('fires once per press, not once per frame held', () => {
    const arena = makeArena();
    try {
      const a = arena.spawn(0, 0, 0);
      const b = arena.spawn(0, 1.1, 1);
      arena.run(700);
      a.facing = 0;

      let thrown = 0;
      const counting = { ...NO_EVENTS, onPunchThrown: () => thrown++ };
      // Feed a press on EVERY step for 200ms. The cooldown must swallow all
      // but the first — the press counter reports taps, and holding the
      // button down must not become a machine gun.
      const steps = Math.round(200 / STEP_MS);
      for (let i = 0; i < steps; i++) {
        a.captureTransform();
        a.step(STEP_MS, { ...IDLE, punches: 1 }, [a, b], counting);
        arena.world.step();
      }
      assert.equal(thrown, 1, `threw ${thrown} punches from a held button`);
    } finally {
      arena.free();
    }
  });
});

describe('grab and throw', () => {
  it('picks a target up and launches it on the second press', () => {
    const arena = makeArena();
    try {
      const a = arena.spawn(0, 0, 0);
      const b = arena.spawn(0, 1.1, 1);
      arena.run(700);
      a.facing = 0;

      arena.run(100, (f, i) => (f === a && i === 0 ? { ...IDLE, grabs: 1 } : IDLE));
      assert.equal(a.holding, b, 'grab did not connect');
      assert.equal(b.heldBy, a);

      const before = b.position.z;
      arena.run(500, (f, i) => (f === a && i === 0 ? { ...IDLE, grabs: 1 } : IDLE));
      assert.equal(a.holding, null, 'still holding after the throw');
      assert.equal(b.heldBy, null);
      assert.ok(b.position.z > before + 1.5, `throw went nowhere: ${before} -> ${b.position.z}`);
    } finally {
      arena.free();
    }
  });

  it('drops whoever it is holding when hit', () => {
    const arena = makeArena();
    try {
      const a = arena.spawn(0, 0, 0);
      const b = arena.spawn(0, 1.1, 1);
      arena.run(700);
      a.facing = 0;
      arena.run(100, (f, i) => (f === a && i === 0 ? { ...IDLE, grabs: 1 } : IDLE));
      assert.equal(a.holding, b);

      a.takeHit(-1, 0, 10, 3);
      assert.equal(a.holding, null);
      assert.equal(b.heldBy, null);
    } finally {
      arena.free();
    }
  });

  it('cannot be grabbed by two people at once', () => {
    const arena = makeArena();
    try {
      const a = arena.spawn(0, 0, 0);
      const b = arena.spawn(0, 1.1, 1);
      const c = arena.spawn(0, 2.2, 2);
      arena.run(700);
      a.facing = 0;
      c.facing = Math.PI;

      arena.run(100, (f, i) => (f === a && i === 0 ? { ...IDLE, grabs: 1 } : IDLE));
      arena.run(100, (f, i) => (f === c && i === 0 ? { ...IDLE, grabs: 1 } : IDLE));
      assert.equal(b.heldBy, a);
      assert.equal(c.holding, null);
    } finally {
      arena.free();
    }
  });
});

/**
 * The stick-to-world mapping.
 *
 * "Up on the stick moves me down the screen" is the most disorienting bug a
 * gamepad can have, and it shipped once: the controller reports screen
 * coordinates (+Y down) and the camera looks along -Z, so BOTH conventions
 * already point the same way and the mapping is the identity. Negating it —
 * which is what it looks like it needs — inverts the control.
 */
describe('stick direction', () => {
  it('maps up on the stick to away from the camera', () => {
    // Thumb pushed up: the controller sends axisY = -1 (screen +Y is down).
    const up = stickToMove(0, -1);
    assert.ok(up.moveZ < 0, 'up on the stick must move toward -Z, away from the camera');

    const down = stickToMove(0, 1);
    assert.ok(down.moveZ > 0, 'down on the stick must move toward +Z');

    assert.equal(stickToMove(1, 0).moveX, 1, 'right on the stick must move toward +X');
    assert.equal(stickToMove(-1, 0).moveX, -1);
  });

  it('actually walks the body away from the camera under real physics', () => {
    const arena = makeArena();
    try {
      // Off to one side: walking -Z from the middle runs straight into the
      // steps of the raised platform, which is a slow climb rather than a walk.
      const f = arena.spawn(-3.4, 2.0);
      arena.run(600);
      const startZ = f.position.z;

      // Full stick up, as the controller would encode it.
      const move = stickToMove(0, -1);
      arena.run(700, () => ({ ...IDLE, moveX: move.moveX, moveZ: move.moveZ }));

      assert.ok(
        f.position.z < startZ - 0.5,
        `pushing up walked the player from z=${startZ} to z=${f.position.z} — the control is inverted`,
      );
    } finally {
      arena.free();
    }
  });

  it('faces the way it is walking', () => {
    const arena = makeArena();
    try {
      const f = arena.spawn(-3.4, 2.0);
      arena.run(600);
      const move = stickToMove(0, -1);
      arena.run(400, () => ({ ...IDLE, moveX: move.moveX, moveZ: move.moveZ }));

      // facing is used as (sin, cos), so away from the camera is cos(facing) < 0.
      assert.ok(Math.cos(f.facing) < -0.8, `facing ${f.facing} is not away from the camera`);
    } finally {
      arena.free();
    }
  });
});

describe('movement', () => {
  it('accelerates rather than snapping to top speed', () => {
    const arena = makeArena();
    try {
      const f = arena.spawn(0, 0);
      arena.run(600);
      f.body.setLinvel({ x: 0, y: 0, z: 0 }, true);

      // One step of full stick must not produce full speed: an impulse landing
      // on a body whose velocity is reassigned from the stick every frame has
      // no effect at all, which is what made punches feel weightless.
      arena.run(STEP_MS, () => ({ ...IDLE, moveX: 1 }));
      const v = f.body.linvel();
      assert.ok(Math.abs(v.x) < 2, `snapped straight to ${v.x} m/s`);

      arena.run(800, () => ({ ...IDLE, moveX: 1 }));
      assert.ok(f.body.linvel().x > 4, 'never reached a useful speed');
    } finally {
      arena.free();
    }
  });

  it('keeps its momentum when the stick is released', () => {
    const arena = makeArena();
    try {
      const f = arena.spawn(0, 0);
      arena.run(600);
      arena.run(700, () => ({ ...IDLE, moveX: 1 }));
      const moving = f.body.linvel().x;
      arena.run(100);
      const coasting = f.body.linvel().x;
      assert.ok(coasting > moving * 0.5, `stopped dead: ${moving} -> ${coasting}`);
    } finally {
      arena.free();
    }
  });

  it('respawns clean', () => {
    const arena = makeArena();
    try {
      const f = arena.spawn(0, 0);
      arena.run(400);
      f.takeHit(1, 0, 14, 5);
      f.eliminate();
      assert.equal(f.alive, false);

      f.respawn({ x: 2, z: -3 });
      assert.equal(f.state, 'up');
      assert.equal(f.alive, true);
      assert.equal(f.animal.root.visible, true);
      const v = f.body.linvel();
      assert.equal(Math.hypot(v.x, v.y, v.z), 0);
      assert.ok(Math.abs(upOf(f).y - 1) < 1e-9, 'respawned still tipped over');
    } finally {
      arena.free();
    }
  });
});

describe('poses', () => {
  it('blends part of the way toward a target rather than snapping', () => {
    const { joints } = buildAnimal('pup', '#ff8a3d');
    blendPose(joints, POSES.idle, 1);
    const full = joints.arms.R.shoulder.rotation.x;

    const fresh = buildAnimal('pup', '#ff8a3d').joints;
    blendPose(fresh, POSES.idle, 0.25);
    const quarter = fresh.arms.R.shoulder.rotation.x;

    assert.ok(Math.abs(quarter) < Math.abs(full), 'a quarter blend moved the whole way');
    assert.ok(Math.abs(quarter - full * 0.25) < 1e-6);
  });

  it('builds every species without throwing', () => {
    for (const s of SPECIES) {
      const a = buildAnimal(s.id, '#7cd6ff');
      assert.ok(a.root.children.length > 0, `${s.id} built nothing`);
      a.dispose();
    }
  });
});

/**
 * The standings list is rebuilt only when this key changes, so anything the row
 * draws must be in it. Names and colours were not, and a player renaming
 * themselves silently did nothing on the big screen.
 */
/**
 * The CPU brawler.
 *
 * These run the real brain against the real fighter on the real level, because
 * the only interesting question about a bot is whether it survives contact with
 * the physics — and the answer for every naive "walk at the nearest target"
 * version was no, it strolls out of a parapet gap in about four seconds.
 */
describe('the CPU', () => {
  /** Run a roof full of bots for `ms` and report who is left. */
  function runBots(count, ms, arena) {
    const brains = [];
    for (let i = 0; i < count; i++) {
      arena.spawn(arena.level.spawnPoints()[i].x, arena.level.spawnPoints()[i].z, i);
      brains.push(new Cpu((i + 0.5) / count));
    }
    const steps = Math.round(ms / STEP_MS);
    for (let s = 0; s < steps; s++) {
      const views = arena.fighters.map((f) => {
        const p = f.position;
        return { x: p.x, y: p.y, z: p.z, alive: f.alive };
      });
      for (let i = 0; i < arena.fighters.length; i++) {
        const f = arena.fighters[i];
        f.captureTransform();
        if (!f.alive) continue;
        const input = brains[i].think(views[i], views, f.holding !== null, STEP_MS, arena.level.safeZone());
        f.step(STEP_MS, input, arena.fighters, NO_EVENTS);
      }
      arena.world.step();
      for (const f of arena.fighters) f.checkFall(arena.level.killY);
    }
    return arena.fighters.filter((f) => f.alive).length;
  }

  it('does not simply walk off the roof', () => {
    const arena = makeArena();
    try {
      // A single bot with nobody to chase must still be alive a long time
      // later. Nothing is pushing it — if it falls, it walked.
      arena.spawn(0, 2.5, 0);
      const brain = new Cpu(0.3);
      const f = arena.fighters[0];
      const steps = Math.round(12000 / STEP_MS);
      for (let s = 0; s < steps; s++) {
        const p = f.position;
        const view = { x: p.x, y: p.y, z: p.z, alive: f.alive };
        f.captureTransform();
        f.step(STEP_MS, brain.think(view, [view], false, STEP_MS, arena.level.safeZone()), arena.fighters, NO_EVENTS);
        arena.world.step();
        f.checkFall(arena.level.killY);
      }
      assert.equal(f.alive, true, 'a lone CPU walked itself off an empty roof');
    } finally {
      arena.free();
    }
  });

  it('keeps a four-bot round going for a while', () => {
    const arena = makeArena();
    try {
      // Not a demand that nobody dies — they are trying to kill each other.
      // The failure this guards is the round evaporating in the first seconds
      // because every bot beelined through a gap.
      const left = runBots(4, 6000, arena);
      assert.ok(left >= 2, `only ${left} of 4 bots survived six seconds`);
    } finally {
      arena.free();
    }
  });

  it('actually fights rather than milling about', () => {
    const arena = makeArena();
    try {
      let punches = 0;
      const events = { ...NO_EVENTS, onPunchThrown: () => punches++ };
      const a = arena.spawn(-1.0, 0, 0);
      const b = arena.spawn(1.0, 0, 1);
      const brains = [new Cpu(0.2), new Cpu(0.8)];
      const steps = Math.round(5000 / STEP_MS);
      for (let s = 0; s < steps; s++) {
        const views = arena.fighters.map((f) => {
          const p = f.position;
          return { x: p.x, y: p.y, z: p.z, alive: f.alive };
        });
        for (let i = 0; i < 2; i++) {
          const f = arena.fighters[i];
          f.captureTransform();
          if (!f.alive) continue;
          f.step(STEP_MS, brains[i].think(views[i], views, f.holding !== null, STEP_MS, arena.level.safeZone()), arena.fighters, events);
        }
        arena.world.step();
        for (const f of arena.fighters) f.checkFall(arena.level.killY);
      }
      assert.ok(punches > 3, `two bots facing each other threw only ${punches} punches`);
      assert.ok(a !== b);
    } finally {
      arena.free();
    }
  });

  it('steers away from an edge instead of into it', () => {
    // Parked right on the south lip with a target beyond it: the bot must not
    // walk toward the target, because the target is over open air.
    const brain = new Cpu(0.4);
    const self = { x: 0, y: 0, z: DECK_Z - 0.7, alive: true };
    const bait = { x: 0, y: 0, z: DECK_Z + 4, alive: true };
    const out = brain.think(self, [self, bait], false, STEP_MS, ROOF_SAFE);
    assert.ok(out.moveZ < 0, `stepped toward the drop (moveZ ${out.moveZ})`);
  });

  it('gives no input once it is already falling', () => {
    const brain = new Cpu(0.4);
    const self = { x: 0, y: -6, z: 0, alive: true };
    const out = brain.think(self, [self], false, STEP_MS, ROOF_SAFE);
    assert.deepEqual(out, { moveX: 0, moveZ: 0, punches: 0, grabs: 0, jumps: 0 });
  });
});

describe('the standings cache key', () => {
  const row = (over = {}) => ({ slot: 0, name: 'Ada', color: '#ff0000', alive: true, place: 0, ...over });

  it('changes when a player renames', () => {
    assert.notEqual(standingsKey([row()]), standingsKey([row({ name: 'Bo' })]));
  });

  it('changes when a player recolours', () => {
    assert.notEqual(standingsKey([row()]), standingsKey([row({ color: '#00ff00' })]));
  });

  it('changes when a player is eliminated', () => {
    assert.notEqual(standingsKey([row()]), standingsKey([row({ alive: false })]));
  });

  it('changes when the order changes', () => {
    const a = row({ slot: 0, name: 'Ada' });
    const b = row({ slot: 1, name: 'Bo' });
    assert.notEqual(standingsKey([a, b]), standingsKey([b, a]));
  });

  it('is stable when nothing visible changed', () => {
    assert.equal(standingsKey([row()]), standingsKey([row()]));
  });
});

describe('the camera', () => {
  it('pulls back far enough to frame everyone', async () => {
    const { PerspectiveCamera, Frustum, Matrix4, Vector3 } = await import('three');
    const cam = new PerspectiveCamera(46, 16 / 9, 0.5, 140);
    const chase = new ChaseCamera(cam);

    const spread = [
      { x: -8, y: 1, z: -6 },
      { x: 8, y: 1, z: 6 },
      { x: 0, y: 4, z: 0 },
    ];
    // Let the distance solver converge; it eases rather than jumping.
    chase.snap(spread);
    for (let i = 0; i < 200; i++) chase.update(spread, 1 / 60, { x: 0, y: 0, z: 0 });

    cam.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
    );
    for (const p of spread) {
      assert.ok(frustum.containsPoint(new Vector3(p.x, p.y, p.z)), `${JSON.stringify(p)} off-screen`);
    }
  });

  /**
   * The near player is the one that gets cropped.
   *
   * Fitting a world-space bounding box against the FOV ignores perspective
   * entirely: whoever is closest to the camera subtends far more of the frame
   * than the far one, so they slide off the bottom edge while the box maths
   * says everything fits.
   */
  it('keeps the nearest player in frame, head and all', async () => {
    const { PerspectiveCamera, Frustum, Matrix4, Vector3 } = await import('three');
    const cam = new PerspectiveCamera(46, 16 / 9, 0.5, 140);
    const chase = new ChaseCamera(cam);

    // Deep spread: one player right at the near edge of the roof, one far.
    const spread = [
      { x: 0, y: 0, z: 5.2 },
      { x: 0, y: 0, z: -5.2 },
    ];
    chase.snap(spread);
    for (let i = 0; i < 400; i++) chase.update(spread, 1 / 60, { x: 0, y: 0, z: 0 });

    cam.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
    );
    for (const p of spread) {
      // Feet and the top of the head plus name tag.
      for (const y of [p.y, p.y + 2.6]) {
        assert.ok(
          frustum.containsPoint(new Vector3(p.x, y, p.z)),
          `(${p.x}, ${y}, ${p.z}) is off-screen`,
        );
      }
    }
  });

  it('is wide enough on an ultrawide screen too', async () => {
    const { PerspectiveCamera, Frustum, Matrix4, Vector3 } = await import('three');
    // 21:9. Computing the fit from the vertical FOV alone passes at 16:9 and
    // then drops players off the left and right edges here.
    const cam = new PerspectiveCamera(46, 21 / 9, 0.5, 140);
    const chase = new ChaseCamera(cam);
    const spread = [
      { x: -9, y: 1, z: 0 },
      { x: 9, y: 1, z: 0 },
    ];
    chase.snap(spread);
    for (let i = 0; i < 200; i++) chase.update(spread, 1 / 60, { x: 0, y: 0, z: 0 });

    cam.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
    );
    for (const p of spread) {
      assert.ok(frustum.containsPoint(new Vector3(p.x, p.y, p.z)), `${JSON.stringify(p)} off-screen`);
    }
  });
});

/**
 * The catalogue.
 *
 * Three games sharing one set of characters and one control scheme, differing
 * in how you WIN. These check the contract every arena has to honour, because
 * an arena that spawns players inside a wall or forgets its kill plane fails in
 * a way that is only visible on a TV.
 */
describe('the games', () => {
  it('offers three distinct win conditions', () => {
    assert.equal(GAMES.length, 3);
    assert.equal(new Set(GAMES.map((g) => g.id)).size, 3);
    // Exactly one health game; the other two are won by position.
    assert.equal(GAMES.filter((g) => g.health !== null).length, 1);
    assert.equal(GAMES.filter((g) => g.health === null).length, 2);
  });

  it('falls back to a real game for an unknown id', () => {
    // A phone can hold a cached page from a build that had different games.
    const g = gameById('no-such-game');
    assert.ok(GAMES.includes(g), 'an unknown id must not leave the host arena-less');
  });

  it('gives every arena four usable spawn points', () => {
    for (const def of GAMES) {
      const arena = makeArena(() => def.createArena());
      try {
        const spawns = arena.level.spawnPoints();
        assert.ok(spawns.length >= 4, `${def.id} has only ${spawns.length} spawns`);
        assert.equal(
          new Set(spawns.slice(0, 4).map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`)).size,
          4,
          `${def.id} spawns two players in the same place`,
        );
      } finally {
        arena.free();
      }
    }
  });

  /**
   * The one thing every arena must get right: a player dropped at a spawn point
   * has to still be there a couple of seconds later. Spawning inside geometry
   * or over a hole is silent until four people are watching.
   */
  it('lets a player just stand still on every arena', () => {
    for (const def of GAMES) {
      const arena = makeArena(() => def.createArena());
      try {
        for (const p of arena.level.spawnPoints().slice(0, 4)) arena.spawn(p.x, p.z);
        arena.run(1800);
        for (const f of arena.fighters) {
          assert.equal(f.alive, true, `${def.id}: a stationary player died at spawn`);
          assert.ok(upOf(f).y > 0.9, `${def.id}: a stationary player is not standing`);
        }
      } finally {
        arena.free();
      }
    }
  });
});

describe('THE PIT', () => {
  it('has no way out, so a runaway cannot escape', () => {
    const arena = makeArena(() => new PitArena());
    try {
      const f = arena.spawn(0, 0);
      // Sprint at the wall for four seconds from the middle.
      arena.run(4000, () => ({ ...IDLE, moveX: 1 }));
      assert.equal(f.alive, true, 'ran straight out of a walled arena');
      assert.ok(f.position.y > -2, `ended below the floor at y = ${f.position.y}`);
    } finally {
      arena.free();
    }
  });

  it('tells the CPU there is nothing to fear', () => {
    assert.equal(new PitArena().safeZone(), null);
  });
});

describe('GRINDER', () => {
  it('carries a passive player off the belt', () => {
    const arena = makeArena(() => new GrinderArena());
    try {
      // Stand on a belt and do nothing. The floor should do the rest — that is
      // the entire premise of the level.
      const f = arena.spawn(0, 1.125);
      const startX = f.position.x;
      const steps = Math.round(2500 / STEP_MS);
      for (let i = 0; i < steps; i++) {
        f.captureTransform();
        f.step(STEP_MS, IDLE, arena.fighters, NO_EVENTS);
        arena.level.step(STEP_MS, arena.fighters);
        arena.world.step();
      }
      assert.ok(
        Math.abs(f.position.x - startX) > 1.5,
        `the belt moved a standing player only ${(f.position.x - startX).toFixed(2)}m`,
      );
    } finally {
      arena.free();
    }
  });

  it('leaves the safe ledge alone', () => {
    const arena = makeArena(() => new GrinderArena());
    try {
      const f = arena.spawn(0, -4.1);
      const startX = f.position.x;
      const steps = Math.round(2500 / STEP_MS);
      for (let i = 0; i < steps; i++) {
        f.captureTransform();
        f.step(STEP_MS, IDLE, arena.fighters, NO_EVENTS);
        arena.level.step(STEP_MS, arena.fighters);
        arena.world.step();
      }
      assert.ok(
        Math.abs(f.position.x - startX) < 0.6,
        'the ledge is supposed to be somewhere you can stand still',
      );
      assert.equal(f.alive, true);
    } finally {
      arena.free();
    }
  });

  it('only calls the pit side unsafe', () => {
    const safe = new GrinderArena().safeZone();
    assert.ok(safe, 'the grinder has an edge, so it must declare a safe zone');
    // North is a solid wall, south is open air: the zone must not be symmetric.
    assert.ok(safe.maxZ < Math.abs(safe.minZ) + 4);
  });
});
