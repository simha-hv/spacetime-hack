import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import { ArenaBuilder, type Arena, type ArenaCtx, type SafeZone } from '../arena.js';
import type { Fighter } from '../fighter.js';

/**
 * GRINDER — the meat-packing line.
 *
 * Where ROOFTOP is a place you get knocked off, this is a place that is
 * actively trying to kill you and does not care whether anyone throws a punch.
 * The floor MOVES. Stand still and you lose.
 *
 * Layout, from north to south:
 *
 *   ┌─────────────── back wall ───────────────┐
 *   │            safe ledge (raised)          │   ← catch your breath here
 *   ├─────────────────────────────────────────┤
 *   │  ← ← ← ←   CONVEYOR   → → → →           │   ← two belts, opposed
 *   ├─────────────────────────────────────────┤
 *   │        THE PIT (open, no floor)         │   ← this is the kill
 *   └─────────────────────────────────────────┘
 *
 * The two belts run in OPPOSITE directions. That is the whole design: standing
 * on the wrong belt drags you toward the pit while your opponent, two metres
 * away on the other belt, is being carried to safety. You are constantly having
 * to fight the floor as well as each other, and a grab becomes far stronger
 * than a punch — carry someone two metres sideways and the level finishes them.
 *
 * Swinging press arms sweep the belts on a slow cycle, so there is a rhythm to
 * learn rather than a constant grind.
 */

const KILL_Y = -16;

/** Half-extents of the whole floor plate. */
/*
 * Deliberately compact.
 *
 * The first pass was 14.8m wide with 8m of depth, and the chase camera — which
 * frames the PLAYERS — showed a slice of featureless grey floor with the belts
 * and the pit both out of shot. A level whose whole point is visible machinery
 * has to fit in frame no matter where the fight drifts.
 */
const HALL_X = 5.6;

/*
 * The floor plan, north (-Z) to south (+Z). These have to agree with each
 * other exactly — the first pass had the belt COLLIDERS in one place and the
 * "are you on a belt" test in another, leaving an unmarked 12cm slot between
 * the two belts that a player could stand in and be pushed by neither.
 *
 *   -6.0            back wall
 *   -5.6 .. -2.6    raised ledge      (safe)
 *   -2.6 ..  0.4    approach floor    (safe, normal grip)
 *    0.4 ..  1.85   belt A -> -X      (slick)
 *    1.95..  3.4    belt B -> +X      (slick)
 *    3.4  ..        the pit           (nothing)
 */
const BELT_A_Z = 0.85;
const BELT_B_Z = 2.15;
const BELT_HALF = 0.6;
/** Midpoint between the two belts; which side of it decides your direction. */
const BELT_SPLIT = (BELT_A_Z + BELT_B_Z) / 2;
const BELT_SPEED = 3.4;
/**
 * How hard the belt pulls.
 *
 * It has to beat contact friction, which is the mistake the first version made:
 * driving at 8 m/s² against a 0.6-friction floor under 22.5 gravity is 8 versus
 * 13.5, so a player standing on a "moving" belt simply did not move. The belt
 * surface is also deliberately slick (see its collider) — a conveyor you can
 * plant your feet on is not a conveyor.
 */
const BELT_GRIP = 7.5;
/** Slippery on purpose. This is the "fighting the floor" feel. */
const BELT_FRICTION = 0.16;

/** The safe ledge along the north side. */
const LEDGE_Z = -3.3;
const LEDGE_HALF = 1.2;
const LEDGE_H = 0.5;

/** Flat ground between the ledge and the belts. */
const APPROACH_Z = -0.85;
const APPROACH_HALF = 1.25;

/** Everything south of this is open air. */
const PIT_EDGE = 2.75;

const PRESS_PERIOD_MS = 5200;

interface Press {
  pivot: THREE.Object3D;
  body: RAPIER.RigidBody;
  /** Phase offset so the two arms do not sweep together. */
  offset: number;
}

export class GrinderArena implements Arena {
  readonly killY = KILL_Y;

  private b!: ArenaBuilder;
  private ctx!: ArenaCtx;
  private readonly presses: Press[] = [];
  private readonly crates: { body: RAPIER.RigidBody; mesh: THREE.Object3D; home: THREE.Vector3 }[] =
    [];
  private clockMs = 0;

  /** Scratch, reused so the step loop never allocates. */
  private readonly impulse = { x: 0, y: 0, z: 0 };

  build(ctx: ArenaCtx): void {
    this.ctx = ctx;
    this.b = new ArenaBuilder(ctx);

    this.buildFloor();
    this.buildBelts();
    this.buildWalls();
    this.buildPresses();
    this.buildCrates();
    this.b.skyline('#2c2a3a', 24);
  }

  /* -------------------------------- pieces -------------------------------- */

  private buildFloor(): void {
    // The raised ledge, so it reads as somewhere deliberate to stand.
    this.b.box(HALL_X, LEDGE_H, LEDGE_HALF, 0, LEDGE_H, LEDGE_Z, '#585f6e');
    // A step down off it.
    this.b.box(HALL_X, 0.32, 0.24, 0, 0.32, LEDGE_Z + LEDGE_HALF + 0.24, '#626a7a');
    // Flat approach: normal grip, so there is somewhere to actually fight
    // before the floor starts working against you.
    this.b.box(HALL_X, 0.3, APPROACH_HALF, 0, -0.3, APPROACH_Z, '#4f5666');
  }

  /**
   * Two belts, opposed.
   *
   * They are ordinary static colliders — the "movement" is an impulse applied
   * to anything standing on them, which is far cheaper and far more stable than
   * a kinematic surface, and it lets a player fight the belt by walking against
   * it instead of being locked to it.
   */
  private buildBelts(): void {
    for (const [z, dir] of [
      [BELT_A_Z, -1],
      [BELT_B_Z, 1],
    ] as [number, number][]) {
      this.b.box(HALL_X, 0.3, BELT_HALF, 0, -0.3, z, dir < 0 ? '#7a5a3a' : '#3a5a7a', true, BELT_FRICTION);

      // Slats, so the direction of travel is visible at a glance rather than
      // something you have to deduce from being dragged off the edge.
      const geo = this.b.track(new THREE.BoxGeometry(0.34, 0.06, BELT_HALF * 2 - 0.2));
      const slat = this.b.mat(dir < 0 ? '#8f6a44' : '#446a8f', 0.85);
      for (let s = -6; s <= 6; s++) {
        const m = new THREE.Mesh(geo, slat);
        m.position.set(s * 0.8, 0.02, z);
        m.receiveShadow = true;
        this.b.add(m);
      }

      /*
       * Chevrons pointing the way the belt runs.
       *
       * These were plain yellow rectangles, which told you a belt was there and
       * nothing about which way it went — the single most important fact on
       * this level. A three-sided cone laid on its side is a triangle, and
       * three of them in a row is unmistakably an arrow.
       */
      const chevron = this.b.track(new THREE.ConeGeometry(0.3, 0.55, 3));
      const chevronMat = this.b.mat('#ffcf4d', 0.7);
      for (let c = -1; c <= 1; c++) {
        for (const sx of [-1, 1]) {
          const a = new THREE.Mesh(chevron, chevronMat);
          a.position.set(sx * (HALL_X - 1.4) + c * 0.42 * dir, 0.06, z);
          // Cones point +Y; tip them onto the floor pointing along ±X.
          a.rotation.z = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
          this.b.add(a);
        }
      }
    }
  }

  private buildWalls(): void {
    const wall = '#4a5162';
    // North: a real wall you cannot be thrown through, so the pit is the only
    // exit and the fight always resolves southward.
    this.b.box(HALL_X, 1.6, 0.4, 0, 1.6, LEDGE_Z - LEDGE_HALF - 0.4, wall);
    // East and west: shorter, and they only run as far as the belts. Past the
    // pit edge there is nothing to stop you.
    for (const sx of [-1, 1]) {
      this.b.box(
        0.4,
        1.2,
        (PIT_EDGE - (LEDGE_Z - LEDGE_HALF)) / 2,
        sx * HALL_X,
        1.2,
        (PIT_EDGE + LEDGE_Z - LEDGE_HALF) / 2,
        wall,
      );
    }
    // A warning stripe along the lip of the pit.
    const geo = this.b.track(new THREE.BoxGeometry(HALL_X * 2, 0.04, 0.5));
    const stripe = new THREE.Mesh(geo, this.b.mat('#ff9b3d', 0.7));
    stripe.position.set(0, 0.02, PIT_EDGE - 0.25);
    this.b.add(stripe);
  }

  /**
   * Swinging press arms.
   *
   * Kinematic position-based bodies: they move on a schedule and are completely
   * unmoved by being hit, which is what makes them read as machinery rather
   * than as another player. They shove; they do not eliminate. The pit does
   * that, and giving the hall exactly one kill mechanism keeps it legible.
   */
  private buildPresses(): void {
    const { rapier, world } = this.ctx;
    for (const [i, sx] of [-1, 1].entries()) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 2.7, 1.15, BELT_SPLIT);
      this.b.add(pivot);

      const geo = this.b.track(new THREE.BoxGeometry(0.5, 0.5, 2.6));
      const arm = new THREE.Mesh(geo, this.b.mat('#b9412f', 0.6));
      arm.castShadow = true;
      pivot.add(arm);

      const post = this.b.track(new THREE.CylinderGeometry(0.22, 0.26, 2.4, 12));
      const mast = new THREE.Mesh(post, this.b.mat('#3a3f4c', 0.7));
      mast.position.set(sx * 2.7, 1.2, BELT_SPLIT);
      mast.castShadow = true;
      this.b.add(mast);

      const body = world.createRigidBody(
        rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(sx * 2.7, 1.15, BELT_SPLIT),
      );
      world.createCollider(rapier.ColliderDesc.cuboid(0.25, 0.25, 1.3).setFriction(0.4), body);
      this.b.statics.push(body);

      this.presses.push({ pivot, body, offset: i * 0.5 });
    }
  }

  private buildCrates(): void {
    const geo = this.b.track(new THREE.BoxGeometry(0.8, 0.8, 0.8));
    const mat = this.b.mat('#b8863f', 0.9);
    for (const [x, z] of [
      [-3.6, LEDGE_Z],
      [3.6, LEDGE_Z],
      [-1.2, APPROACH_Z],
      [1.6, BELT_B_Z],
    ] as [number, number][]) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.b.add(mesh);

      const y = z === LEDGE_Z ? 1.45 : 0.45;
      const body = this.ctx.world.createRigidBody(
        this.ctx.rapier.RigidBodyDesc.dynamic()
          .setTranslation(x, y, z)
          .setLinearDamping(0.35)
          .setAngularDamping(0.6)
          .setCcdEnabled(true),
      );
      this.ctx.world.createCollider(
        this.ctx.rapier.ColliderDesc.cuboid(0.4, 0.4, 0.4).setDensity(0.35).setFriction(0.7),
        body,
      );
      this.crates.push({ body, mesh, home: new THREE.Vector3(x, y, z) });
    }
  }

  /* -------------------------------- runtime ------------------------------- */

  /**
   * Only the south edge kills; the other three are walled. The safe strip stops
   * short of the pit lip, which is what stops a bot riding the belt over it.
   */
  safeZone(): SafeZone {
    return {
      minX: -(HALL_X - 0.5),
      maxX: HALL_X - 0.5,
      minZ: LEDGE_Z - LEDGE_HALF,
      maxZ: PIT_EDGE - 0.9,
    };
  }

  spawnPoints(): { x: number; z: number }[] {
    // All four start on the safe ledge. Dropping people straight onto a moving
    // belt at the countdown is a coin flip, not a fight.
    return [
      { x: -3.6, z: LEDGE_Z },
      { x: -1.2, z: LEDGE_Z },
      { x: 1.2, z: LEDGE_Z },
      { x: 3.6, z: LEDGE_Z },
    ];
  }

  step(dtMs: number, fighters: readonly Fighter[]): void {
    this.clockMs += dtMs;
    const dt = dtMs / 1000;

    // Swing the presses. Position-based kinematic bodies are driven by setting
    // their next rotation; Rapier derives the velocity that gets them there,
    // which is what makes them actually push bodies out of the way.
    for (const p of this.presses) {
      const phase = ((this.clockMs / PRESS_PERIOD_MS + p.offset) % 1) * Math.PI * 2;
      const angle = Math.sin(phase) * 1.15;
      p.pivot.rotation.y = angle;
      const half = angle / 2;
      p.body.setNextKinematicRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
    }

    // Drive the belts. Anything low enough to be standing on one gets pushed
    // along it — including crates, but fighters are what matter.
    for (const f of fighters) {
      if (!f.alive) continue;
      const p = f.position;
      if (p.y > 1.2 || p.y < -1) continue;
      if (Math.abs(p.x) > HALL_X) continue;

      // One continuous band covering both belts, so the seam between them is
      // not a dead strip you can stand in and be pushed by neither.
      if (p.z < BELT_A_Z - BELT_HALF || p.z > BELT_B_Z + BELT_HALF) continue;

      // Which of the two: the near one runs -X, the far one +X.
      const dir = p.z < BELT_SPLIT ? -1 : 1;
      const v = f.body.linvel();
      // Accelerate toward belt speed rather than setting it, so a player can
      // still walk against the belt and win — slowly.
      const target = dir * BELT_SPEED;
      this.impulse.x = (target - v.x) * BELT_GRIP * dt * f.mass;
      this.impulse.y = 0;
      this.impulse.z = 0;
      f.body.applyImpulse(this.impulse, true);
    }
  }

  sync(): void {
    for (const c of this.crates) {
      const t = c.body.translation();
      if (t.y < KILL_Y) {
        c.body.setEnabled(false);
        c.mesh.visible = false;
        continue;
      }
      c.mesh.position.set(t.x, t.y, t.z);
      const r = c.body.rotation();
      c.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  reset(): void {
    this.clockMs = 0;
    for (const c of this.crates) {
      c.body.setEnabled(true);
      c.body.setTranslation(c.home, true);
      c.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      c.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      c.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      c.mesh.visible = true;
    }
  }

  dispose(): void {
    this.b.dispose();
    for (const c of this.crates) this.ctx.world.removeRigidBody(c.body);
    this.crates.length = 0;
    this.presses.length = 0;
  }
}
