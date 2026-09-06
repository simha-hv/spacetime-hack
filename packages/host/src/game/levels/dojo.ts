import * as THREE from 'three';

import { ArenaBuilder, type Arena, type ArenaCtx } from '../arena.js';

/**
 * THE PIT — a walled arena with nowhere to fall.
 *
 * The other two levels are won by putting someone somewhere. This one cannot
 * be: the wall runs all the way round and it is too tall to be thrown over.
 * The only way out is to take someone's health bar off them, which makes it a
 * completely different game with the same characters — spacing, whiff-punishing
 * and pressure instead of positioning and edge control.
 *
 * That is also why it is round rather than rectangular. A rectangle has corners
 * to be trapped in, and being cornered with no escape and no ring-out is just
 * losing slowly. A circle means there is always somewhere to go, so a losing
 * player is always one good read from turning it around.
 *
 * The floor is dressed as a sunken fighting pit under torchlight because the
 * fight is a spectacle here, not an accident.
 */

const RADIUS = 6.4;
/**
 * The wall you can SEE is low. The wall that CONTAINS you is not.
 *
 * A 2.6m stone ring looked right in isolation and was unusable in practice:
 * the chase camera sits low and looks down, so the near segments stood between
 * the viewer and the fight and simply hid it. Dropping the visible course to
 * knee height fixes the view, and an invisible barrier above it keeps the
 * "nowhere to fall" promise that the whole game mode rests on.
 */
const WALL_H = 1.05;
const BARRIER_H = 4.2;
const WALL_SEGMENTS = 28;

export class PitArena implements Arena {
  // Nothing can leave, so this only ever catches a physics accident.
  readonly killY = -20;

  private b!: ArenaBuilder;

  build(ctx: ArenaCtx): void {
    this.b = new ArenaBuilder(ctx);
    this.buildFloor();
    this.buildWall();
    this.buildDressing();
  }

  private buildFloor(): void {
    const { rapier, world } = this.b.ctx;

    const geo = this.b.track(new THREE.CylinderGeometry(RADIUS, RADIUS + 0.5, 1.2, 40));
    const floor = new THREE.Mesh(geo, this.b.mat('#6b5b4a', 0.96));
    floor.position.y = -0.6;
    floor.receiveShadow = true;
    this.b.add(floor);

    const body = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(0, -0.6, 0));
    world.createCollider(rapier.ColliderDesc.cylinder(0.6, RADIUS).setFriction(0.9), body);
    this.b.statics.push(body);

    // Concentric rings, so movement across the floor is readable. A flat
    // untextured disc gives the eye nothing to judge distance against, which
    // matters far more here than on a rooftop covered in props.
    for (const [r, c] of [
      [RADIUS * 0.78, '#5f5140'],
      [RADIUS * 0.44, '#665847'],
    ] as [number, string][]) {
      const ring = this.b.track(new THREE.RingGeometry(r - 0.06, r, 48));
      const m = new THREE.Mesh(ring, this.b.mat(c, 0.95, { side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.011;
      this.b.add(m);
    }
  }

  /**
   * The wall.
   *
   * Built from a ring of boxes rather than one cylinder collider, because
   * Rapier's cylinder is solid — a body would be trapped inside it, not
   * contained by it. Segments also let the top course be offset outward for a
   * visible lip.
   */
  private buildWall(): void {
    const inner = RADIUS + 0.1;
    const segW = (Math.PI * 2 * inner) / WALL_SEGMENTS / 2 + 0.06;
    const { rapier, world } = this.b.ctx;

    const geo = this.b.track(new THREE.BoxGeometry(segW * 2, WALL_H, 0.7));
    const stone = this.b.mat('#8b8477', 0.95);
    const capGeo = this.b.track(new THREE.BoxGeometry(segW * 2.05, 0.24, 0.95));
    const capMat = this.b.mat('#a49c8c', 0.9);

    for (let i = 0; i < WALL_SEGMENTS; i++) {
      const a = (i / WALL_SEGMENTS) * Math.PI * 2;
      const x = Math.cos(a) * (inner + 0.35);
      const z = Math.sin(a) * (inner + 0.35);

      const mesh = new THREE.Mesh(geo, stone);
      mesh.position.set(x, WALL_H / 2, z);
      mesh.rotation.y = -a;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.b.add(mesh);

      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.set(x, WALL_H + 0.12, z);
      cap.rotation.y = -a;
      cap.castShadow = true;
      this.b.add(cap);

      // One collider, tall enough that nothing leaves — the visible masonry is
      // only the bottom quarter of it.
      const body = world.createRigidBody(
        rapier.RigidBodyDesc.fixed()
          .setTranslation(x, BARRIER_H / 2, z)
          .setRotation({ x: 0, y: Math.sin(-a / 2), z: 0, w: Math.cos(-a / 2) }),
      );
      world.createCollider(
        rapier.ColliderDesc.cuboid(segW, BARRIER_H / 2, 0.35).setFriction(0.2),
        body,
      );
      this.b.statics.push(body);
    }
  }

  private buildDressing(): void {
    /*
     * Torches on posts outside the ring.
     *
     * A cone, not a sphere: the first version was a pale sphere in a cup and
     * read unmistakably as an egg in an egg cup. Emissive rather than a real
     * light — four more point lights would double the shading cost of every
     * material in the scene for a glow nothing is actually lit by.
     */
    const post = this.b.track(new THREE.CylinderGeometry(0.09, 0.12, 2.1, 8));
    const postMat = this.b.mat('#2f2a26', 0.85);
    const flame = this.b.track(new THREE.ConeGeometry(0.2, 0.62, 7));
    const flameMat = this.b.mat('#ff8a1e', 0.4, {
      emissive: new THREE.Color('#ff6a00'),
      emissiveIntensity: 2.6,
    });

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const x = Math.cos(a) * (RADIUS + 1.5);
      const z = Math.sin(a) * (RADIUS + 1.5);
      const p = new THREE.Mesh(post, postMat);
      p.position.set(x, 1.05, z);
      p.castShadow = true;
      this.b.add(p);
      const f = new THREE.Mesh(flame, flameMat);
      f.position.set(x, 2.35, z);
      this.b.add(f);
    }

    this.b.skyline('#241f2e', 26, 21, 16);
  }

  /** Walled all the way round: nothing to fall off, so nothing to fear. */
  safeZone(): null {
    return null;
  }

  spawnPoints(): { x: number; z: number }[] {
    // On a circle, evenly spaced. Everyone starts the same distance from
    // everyone else, so no seat has an opening advantage.
    const r = RADIUS * 0.66;
    return [0, 1, 2, 3].map((i) => {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      return { x: Math.cos(a) * r, z: Math.sin(a) * r };
    });
  }

  reset(): void {
    /* Nothing loose to put back. */
  }

  sync(): void {
    /* Nothing dynamic to sync. */
  }

  dispose(): void {
    this.b.dispose();
  }
}
