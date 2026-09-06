import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import { ArenaBuilder, type Arena, type ArenaCtx, type SafeZone } from '../arena.js';

/**
 * ROOFTOP — an actual place, not a disc.
 *
 * The previous two arenas were both a flat circular platform, which is the
 * SPIN OUT layout in different colours. Party Animals levels are somewhere:
 * a rooftop, a kitchen, a building site, with props to trip over, ledges at
 * different heights and things you can be thrown into.
 *
 * So this is a rectangular rooftop with:
 *  - a raised deck at one end, so height matters and a throw can drop someone
 *  - two fixed AC units to break line of sight and block a charge
 *  - loose crates that are real dynamic bodies: shove them, trip on them, get
 *    knocked into them
 *  - a low parapet around most of the edge, but two open gaps that are the
 *    actual kill zones
 *
 * The parapet is the important part. With an open edge everyone strolls off in
 * two seconds and nobody ever fights; with a wall all the way round nobody can
 * ever be eliminated. Gaps make the fight directional — you manoeuvre people
 * toward a specific side.
 */

export const KILL_Y = -14;

/**
 * Rooftop footprint, half-extents.
 *
 * Deliberately small. The first pass was 19x14 metres for characters under two
 * metres tall, and the result was that the camera had to pull back far enough
 * to frame it that the players were seven percent of the screen height — plus
 * four people could wander around for ten seconds without meeting. A tight
 * roof forces the fight and keeps the cast readable.
 */
export const DECK_X = 6.6;
export const DECK_Z = 5.4;
const DECK_THICK = 0.6;

const PARAPET_H = 0.85;
/** Exported so the CPU knows how far in the safe interior of the roof starts. */
export const PARAPET_T = 0.4;
/** Half-width of the open gap in the middle of the north and south walls. */
export const GAP = 2.0;

export interface Prop {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  /** Home transform, so a round can reset without rebuilding the level. */
  home: { x: number; y: number; z: number };
}

export class RooftopArena implements Arena {
  readonly killY = KILL_Y;

  private rapier!: typeof RAPIER;
  private world!: RAPIER.World;
  private scene!: THREE.Scene;
  private b!: ArenaBuilder;

  /** Loose crates. Public so the match can step their meshes and reset them. */
  readonly props: Prop[] = [];

  build(ctx: ArenaCtx): void {
    this.rapier = ctx.rapier;
    this.world = ctx.world;
    this.scene = ctx.scene;
    this.b = new ArenaBuilder(ctx);

    this.buildDeck();
    this.buildFacade();
    this.buildParapet();
    this.buildAcUnits();
    this.buildRaisedPlatform();
    this.buildCrates();
    this.buildSkyline();
  }

  /* ------------------------------- helpers -------------------------------- */

  private m(color: string, rough = 0.95): THREE.MeshStandardMaterial {
    return this.b.mat(color, rough);
  }

  private box(
    hx: number,
    hy: number,
    hz: number,
    x: number,
    y: number,
    z: number,
    color: string,
    solid = true,
  ): THREE.Mesh {
    return this.b.box(hx, hy, hz, x, y, z, color, solid);
  }

  /* -------------------------------- pieces -------------------------------- */

  private buildDeck(): void {
    this.box(DECK_X, DECK_THICK, DECK_Z, 0, -DECK_THICK, 0, '#6a6f7d');

    // Tar strips: purely visual, but a featureless grey slab reads as a
    // placeholder and this is nearly free.
    for (let i = -2; i <= 2; i++) {
      const geo = new THREE.BoxGeometry(DECK_X * 2 - 0.6, 0.02, 0.22);
      this.b.track(geo);
      const strip = new THREE.Mesh(geo, this.m('#5b606d'));
      strip.position.set(0, 0.01, i * 1.8);
      strip.receiveShadow = true;
      this.b.add(strip);
    }
  }

  /**
   * The building under the roof.
   *
   * Purely visual — nothing can reach it, and it carries no collider. But
   * without it the deck reads as a grey slab floating in a void, and the whole
   * bottom half of the screen is empty background. Twenty metres of facade
   * dropping out of frame is what turns the same geometry into a rooftop.
   *
   * It is inset slightly so the parapet overhangs, which is what gives the roof
   * edge a readable lip instead of one continuous flat face.
   */
  private buildFacade(): void {
    const inset = 0.35;
    const top = -DECK_THICK * 2;
    const bottom = -32;
    const h = (top - bottom) / 2;
    this.box(DECK_X - inset, h, DECK_Z - inset, 0, bottom + h, 0, '#2b3145', false);

    // Floor bands. Cheap, and they give the drop a sense of scale — without
    // them the facade is a featureless wall and could be any height.
    for (let i = 0; i < 9; i++) {
      const y = top - 1.6 - i * 2.4;
      const geo = new THREE.BoxGeometry((DECK_X - inset) * 2 + 0.06, 0.5, (DECK_Z - inset) * 2 + 0.06);
      this.b.track(geo);
      const band = new THREE.Mesh(geo, this.m('#39405a', 1));
      band.position.set(0, y, 0);
      this.b.add(band);
    }
  }

  /**
   * A parapet with two deliberate gaps.
   *
   * Everyone walking off instantly is what killed the previous arena. A wall
   * fixes that but removes elimination entirely, so the gaps are the whole
   * design: they are where the fight goes.
   */
  private buildParapet(): void {
    const y = PARAPET_H / 2;
    const wall = '#8a8f9c';

    // East and west: solid.
    this.box(PARAPET_T, PARAPET_H / 2, DECK_Z, DECK_X - PARAPET_T, y, 0, wall);
    this.box(PARAPET_T, PARAPET_H / 2, DECK_Z, -(DECK_X - PARAPET_T), y, 0, wall);

    // North and south: split, leaving a gap in the middle of each.
    const segment = (DECK_X - GAP) / 2;
    for (const sz of [-1, 1]) {
      for (const sx of [-1, 1]) {
        this.box(
          segment,
          PARAPET_H / 2,
          PARAPET_T,
          sx * (GAP + segment),
          y,
          sz * (DECK_Z - PARAPET_T),
          wall,
        );
      }
      // A warning stripe on the floor at each gap.
      const geo = new THREE.BoxGeometry(GAP * 2, 0.03, 0.5);
      this.b.track(geo);
      const stripe = new THREE.Mesh(geo, this.m('#ffcf4d', 0.7));
      stripe.position.set(0, 0.02, sz * (DECK_Z - 0.55));
      stripe.receiveShadow = true;
      this.b.add(stripe);
    }
  }

  private buildAcUnits(): void {
    for (const sx of [-1, 1]) {
      const x = sx * 4.1;
      const z = sx * 2.0;
      this.box(0.8, 0.55, 0.68, x, 0.55, z, '#b9c0cc');
      // Grille on top, so it is obviously an object and not a step.
      const geo = new THREE.CylinderGeometry(0.4, 0.4, 0.12, 14);
      this.b.track(geo);
      const fan = new THREE.Mesh(geo, this.m('#5d6472', 0.6));
      fan.position.set(x, 1.14, z);
      fan.castShadow = true;
      this.b.add(fan);
    }
  }

  /** A raised deck at one end: height, and somewhere to be thrown down from. */
  private buildRaisedPlatform(): void {
    this.box(2.1, 0.45, 1.7, 0, 0.45, -3.2, '#7b8290');
    // Steps up to it, so it is reachable without a jump.
    this.box(2.1, 0.16, 0.4, 0, 0.16, -1.0, '#848b99');
    this.box(2.1, 0.31, 0.4, 0, 0.31, -1.6, '#7f8694');
  }

  /**
   * Loose crates.
   *
   * Real dynamic bodies, so they get shoved around, tripped over and knocked
   * off the roof. They are most of what makes the space feel like a place
   * rather than a diagram.
   */
  private buildCrates(): void {
    const spots: [number, number][] = [
      [-2.2, 2.6],
      [2.4, 2.3],
      [-4.6, -1.6],
      [4.4, -2.2],
      [0.4, 1.1],
    ];
    const geo = new THREE.BoxGeometry(0.86, 0.86, 0.86);
    this.b.track(geo);

    for (const [x, z] of spots) {
      const mesh = new THREE.Mesh(geo, this.m('#c08a4e', 0.9));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.b.add(mesh);

      const body = this.world.createRigidBody(
        this.rapier.RigidBodyDesc.dynamic()
          .setTranslation(x, 0.45, z)
          .setLinearDamping(0.35)
          .setAngularDamping(0.6)
          .setCcdEnabled(true),
      );
      this.world.createCollider(
        this.rapier.ColliderDesc.cuboid(0.43, 0.43, 0.43).setDensity(0.35).setFriction(0.7),
        body,
      );
      this.props.push({ body, mesh, home: { x, y: 0.45, z } });
    }
  }

  /** Distant blocks so the roof reads as being up somewhere, not floating. */
  private buildSkyline(): void {
    this.b.skyline('#39415c', 22);
  }

  /* ------------------------------- lifecycle ------------------------------ */

  /**
   * East and west are solid parapet, so the full deck width is safe. Only the
   * north and south edges have gaps in them, and those are inset.
   */
  safeZone(): SafeZone {
    return {
      minX: -(DECK_X - PARAPET_T),
      maxX: DECK_X - PARAPET_T,
      minZ: -(DECK_Z - PARAPET_T - 0.7),
      maxZ: DECK_Z - PARAPET_T - 0.7,
    };
  }

  /** Player start positions, spread across the roof and facing inward. */
  spawnPoints(): { x: number; z: number }[] {
    return [
      { x: -3.4, z: 2.9 },
      { x: 3.4, z: 2.9 },
      { x: -3.4, z: -0.9 },
      { x: 3.4, z: -0.9 },
    ];
  }

  /** Put the crates back for a new round. */
  reset(): void {
    for (const p of this.props) {
      p.body.setEnabled(true);
      p.body.setTranslation(p.home, true);
      p.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      p.mesh.visible = true;
    }
  }

  /** Sync crate meshes and retire any that fell off the roof. */
  sync(): void {
    for (const p of this.props) {
      const t = p.body.translation();
      if (t.y < KILL_Y) {
        p.body.setEnabled(false);
        p.mesh.visible = false;
        continue;
      }
      p.mesh.position.set(t.x, t.y, t.z);
      const r = p.body.rotation();
      p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  dispose(): void {
    this.b.dispose();
    for (const p of this.props) this.world.removeRigidBody(p.body);
    this.props.length = 0;
  }
}
