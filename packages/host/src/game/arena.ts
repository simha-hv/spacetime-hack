import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import type { Fighter } from './fighter.js';

/**
 * The seam between the match loop and a level.
 *
 * There are several games now and they differ mostly in WHERE you fight and
 * what the place does to you — a static rooftop you get knocked off, a moving
 * conveyor that carries you into a hazard, a walled pit with nowhere to fall.
 * Everything above this interface (fighters, camera, HUD, phones, CPUs) is
 * shared; everything below it is the game.
 *
 * `step` is the important one. A level is allowed to be an active participant:
 * push bodies around, move geometry, hurt people. It gets the fighters and the
 * fixed timestep, and it can do to them anything a punch could.
 */
export interface ArenaCtx {
  rapier: typeof RAPIER;
  world: RAPIER.World;
  scene: THREE.Scene;
}

/**
 * The rectangle a CPU tries to stay inside.
 *
 * Declared by the arena rather than baked into the bot, because "where is it
 * safe to stand" is the one thing that changes completely between levels: the
 * rooftop is bounded north and south by open gaps but walled east and west, the
 * grinder is bounded only to the south, and the pit is fully enclosed and has
 * no unsafe ground at all.
 */
export interface SafeZone {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Arena {
  /** Below this height a fighter is gone. */
  readonly killY: number;

  /**
   * Where a bot should keep itself. `null` means fully enclosed — there is
   * nowhere to fall, so self-preservation is not a consideration and a bot that
   * backed away from walls would just look timid.
   */
  safeZone(): SafeZone | null;

  build(ctx: ArenaCtx): void;

  /** Where players start. At least four, spread out and facing inward. */
  spawnPoints(): { x: number; z: number }[];

  /**
   * Per fixed step, while a round is live. Hazards, conveyors, moving parts.
   * Optional: a static level does not need one.
   */
  step?(dtMs: number, fighters: readonly Fighter[]): void;

  /** Put loose props and moving parts back for a new round. */
  reset(): void;

  /** Copy physics transforms onto the meshes. Called every step. */
  sync(): void;

  dispose(): void;
}

/**
 * Shared construction plumbing.
 *
 * Every arena builds itself out of boxes, tracks its own geometry and
 * materials, and has to give all of them back on dispose — three.js does not
 * free GPU buffers on garbage collection, so a level that forgets leaks the
 * whole thing every time the players pick a different game.
 */
export class ArenaBuilder {
  readonly statics: RAPIER.RigidBody[] = [];
  readonly objects: THREE.Object3D[] = [];
  readonly materials: THREE.Material[] = [];
  readonly geometries: THREE.BufferGeometry[] = [];

  constructor(readonly ctx: ArenaCtx) {}

  mat(color: string, rough = 0.95, extra: THREE.MeshStandardMaterialParameters = {}) {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: rough,
      ...extra,
    });
    this.materials.push(m);
    return m;
  }

  /** A box, given HALF-extents, matching Rapier's cuboid convention. */
  box(
    hx: number,
    hy: number,
    hz: number,
    x: number,
    y: number,
    z: number,
    color: string,
    solid = true,
    friction = 0.85,
  ): THREE.Mesh {
    const geo = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, this.mat(color));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.add(mesh);

    if (solid) {
      const body = this.ctx.world.createRigidBody(
        this.ctx.rapier.RigidBodyDesc.fixed().setTranslation(x, y, z),
      );
      this.ctx.world.createCollider(
        this.ctx.rapier.ColliderDesc.cuboid(hx, hy, hz).setFriction(friction),
        body,
      );
      this.statics.push(body);
    }
    return mesh;
  }

  /** Track a mesh built by hand so it is added to the scene and disposed. */
  add<T extends THREE.Object3D>(object: T): T {
    this.ctx.scene.add(object);
    this.objects.push(object);
    return object;
  }

  track<T extends THREE.BufferGeometry>(geo: T): T {
    this.geometries.push(geo);
    return geo;
  }

  /** Distant blocks so an arena reads as being somewhere, not floating. */
  skyline(color: string, minRadius: number, seed0 = 9, count = 22): void {
    const geo = this.track(new THREE.BoxGeometry(1, 1, 1));
    const far = this.mat(color, 1);
    let seed = seed0;
    for (let i = 0; i < count; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const a = (i / count) * Math.PI * 2;
      const r = minRadius + ((seed >> 8) % 14);
      const h = 6 + ((seed >> 4) % 16);
      const b = new THREE.Mesh(geo, far);
      b.position.set(Math.cos(a) * r, h / 2 - 14, Math.sin(a) * r);
      b.scale.set(4 + ((seed >> 12) % 4), h, 4 + ((seed >> 16) % 4));
      this.add(b);
    }
  }

  dispose(): void {
    for (const o of this.objects) this.ctx.scene.remove(o);
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const b of this.statics) this.ctx.world.removeRigidBody(b);
    this.objects.length = 0;
    this.geometries.length = 0;
    this.materials.length = 0;
    this.statics.length = 0;
  }
}
