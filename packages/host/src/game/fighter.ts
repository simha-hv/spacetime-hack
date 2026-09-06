import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import { blendPose, buildAnimal, POSES, type Animal, type SpeciesId } from './animal.js';

/**
 * An active-ragdoll animal.
 *
 * Rotation is FREE. The body is held upright by a PD torque that is constantly
 * straining against gravity and momentum, and a hard enough hit simply
 * overwhelms it — there is no separate "knocked down" mode, the physics does
 * it. That is what produces the wobble, the stagger and the scramble back to
 * standing that the genre runs on.
 *
 * Two things here were found the hard way and are worth not re-deriving:
 *
 *  - The righting axis is `cross(up, worldUp)` = (-up.z, 0, up.x). The
 *    opposite sign drives the body AWAY from upright and parks it on its head,
 *    which looks exactly like a stuck ragdoll rather than a flipped vector.
 *  - Rapier emits NO contact events unless a collider opts in with
 *    `ActiveEvents`. Without it the whole knockdown path is silently dead.
 */

export type FighterState = 'up' | 'stunned' | 'out';

const RADIUS = 0.42;
const HALF_HEIGHT = 0.4;

const SPEED = 6.2;
const GROUND_ACCEL = 38;
const AIR_ACCEL = 11;

/**
 * Upright PD gains, swept against the physics harness rather than guessed.
 * P=21 never really gets up; P=130 snaps upright in 0.3s and looks robotic.
 * P=62 takes about 0.9s once the stun ends — visible struggle, not sluggish.
 */
const UPRIGHT_P = 62;
const UPRIGHT_D = 8;
const YAW_P = 16;
const YAW_D = 2.8;

const JUMP_SPEED = 7.4;

/*
 * Punch timing and force.
 *
 * Tuned UP from the first pass, which was too polite to read from across a
 * room: the knockback was a nudge, so a landed hit and a whiff looked the same
 * and nobody could tell what anything did. A punch now visibly launches people.
 *
 * The windup is longer too. 60ms is below the threshold where an animation
 * registers at all — the arm was already retracting before anyone saw it move.
 *
 * Not turned up further: at 13.5 a single clean hit sent people straight off a
 * 13-metre roof and rounds ended in three seconds, which is its own kind of
 * unreadable. The force should carry you several metres, not always off.
 */
const PUNCH_WINDUP = 95;
const PUNCH_ACTIVE = 130;
const PUNCH_RECOVER = 210;
const PUNCH_RANGE = 1.75;
/** cos of the half-arc — about 50° either side. */
const PUNCH_ARC = 0.64;
const PUNCH_IMPULSE = 11.5;
const PUNCH_LIFT = 4.2;
const PUNCH_RECOIL = 2.2;
/** Forward shove on the puncher during the windup, so the swing has a step behind it. */
const PUNCH_LUNGE = 3.6;

const GRAB_RANGE = 1.55;
const GRAB_ARC = 0.5;
const HOLD_P = 58;
const HOLD_D = 9;
const THROW_IMPULSE = 15.5;
const THROW_LIFT = 6.6;

const STUN_MS = 900;
const RECOVER_MS = 300;

/* ----------------------- scratch, reused every step ---------------------- */

const _up = { x: 0, y: 0, z: 0 };
const _torque = { x: 0, y: 0, z: 0 };
const _impulse = { x: 0, y: 0, z: 0 };

export interface FighterInput {
  moveX: number;
  moveZ: number;
  punches: number;
  grabs: number;
  jumps: number;
}

export interface FighterEvents {
  onPunchThrown(): void;
  /** `victimSlot` is who was hit — the health games need to know. */
  onHit(power: number, x: number, y: number, z: number, victimSlot: number): void;
  onGrab(): void;
  onThrow(victimSlot: number): void;
  onLand(power: number): void;
}

export class Fighter {
  readonly animal: Animal;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly mass: number;

  state: FighterState = 'up';
  facing = 0;

  private stunMs = 0;
  private punchMs = -1;
  private punchLanded = false;
  private grounded = false;
  private coyoteMs = 0;
  private prevVy = 0;
  private animTime = 0;
  private reachMs = 0;

  holding: Fighter | null = null;
  heldBy: Fighter | null = null;
  eliminatedAt: number | null = null;

  private readonly prevPos = new THREE.Vector3();
  private readonly currPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly currQuat = new THREE.Quaternion();

  constructor(
    private readonly rapier: typeof RAPIER,
    private readonly world: RAPIER.World,
    readonly slot: number,
    species: SpeciesId,
    color: string,
    bulk: number,
    spawn: { x: number; z: number },
  ) {
    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, 1.2, spawn.z)
        .setLinearDamping(0.3)
        // Angular damping does much of the work of settling the wobble
        // instead of spinning forever once you are let go.
        .setAngularDamping(1.5)
        .setCcdEnabled(true),
    );

    this.collider = world.createCollider(
      rapier.ColliderDesc.capsule(HALF_HEIGHT * bulk, RADIUS * bulk)
        .setFriction(0.6)
        .setRestitution(0.05)
        .setDensity(1.0 * bulk)
        // Without this Rapier emits no contact events at all and nothing can
        // ever knock anyone over.
        .setActiveEvents(rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(0),
      this.body,
    );
    this.mass = this.body.mass();

    this.animal = buildAnimal(species, color);
    this.animal.root.scale.setScalar(bulk);
    this.currPos.set(spawn.x, 1.2, spawn.z);
    this.prevPos.copy(this.currPos);
  }

  get alive(): boolean {
    return this.state !== 'out';
  }

  get position(): { x: number; y: number; z: number } {
    return this.body.translation();
  }

  setColor(hex: string): void {
    this.animal.setColor(hex);
  }

  private get authority(): number {
    if (this.state !== 'up') return 0;
    if (this.heldBy) return 0.25;
    return this.grounded ? 1 : 0.45;
  }

  /* ------------------------------ simulation ----------------------------- */

  step(dtMs: number, input: FighterInput, peers: readonly Fighter[], ev: FighterEvents): void {
    if (this.state === 'out') return;
    const dt = dtMs / 1000;
    this.animTime += dt;

    this.updateGrounded(ev);

    if (this.stunMs > 0) {
      this.stunMs -= dtMs;
      if (this.stunMs <= 0 && this.state === 'stunned') this.state = 'up';
    }
    if (this.reachMs > 0) this.reachMs -= dtMs;

    const moveLen = Math.hypot(input.moveX, input.moveZ);
    if (moveLen > 0.1 && this.state === 'up') {
      this.facing = Math.atan2(input.moveX, input.moveZ);
    }

    this.applyMovement(dt, input, moveLen);
    this.applyUpright(dt);
    if (input.jumps > 0) this.jump();
    this.updatePunch(dtMs, input, peers, ev);
    this.updateGrab(input, peers, ev);
    if (this.holding) this.carry(dt);
    this.animate(dt, moveLen);
  }

  private applyMovement(dt: number, input: FighterInput, moveLen: number): void {
    const authority = this.authority;
    if (authority <= 0 || moveLen < 0.08) return;

    const v = this.body.linvel();
    const scale = moveLen > 1 ? 1 / moveLen : 1;
    const targetX = input.moveX * scale * SPEED * authority;
    const targetZ = input.moveZ * scale * SPEED * authority;

    // Clamped acceleration, never a velocity assignment. Assigning velocity
    // from the stick each frame erases any impulse on the very next frame and
    // makes every punch weightless.
    const maxDv = (this.grounded ? GROUND_ACCEL : AIR_ACCEL) * dt * authority;
    let dvx = targetX - v.x;
    let dvz = targetZ - v.z;
    const dv = Math.hypot(dvx, dvz);
    if (dv > maxDv && dv > 0) {
      dvx = (dvx / dv) * maxDv;
      dvz = (dvz / dv) * maxDv;
    }
    _impulse.x = dvx * this.mass;
    _impulse.y = 0;
    _impulse.z = dvz * this.mass;
    this.body.applyImpulse(_impulse, true);
  }

  private applyUpright(dt: number): void {
    if (this.state !== 'up') return;

    const q = this.body.rotation();
    // up = q * (0,1,0)
    _up.x = 2 * (q.x * q.y - q.w * q.z);
    _up.y = 1 - 2 * (q.x * q.x + q.z * q.z);
    _up.z = 2 * (q.y * q.z + q.w * q.x);

    const av = this.body.angvel();

    // cross(up, worldUp) with worldUp = (0,1,0) reduces to (-up.z, 0, up.x).
    // Mind the sign — the negation of this parks the body on its head.
    let ax = -_up.z;
    let az = _up.x;

    const tilt = Math.atan2(Math.hypot(ax, az), _up.y);
    if (tilt > 2.45) {
      // The error vanishes at exactly 180°, and normalising there amplifies
      // float noise into a random axis every frame. Bias with the body's own
      // facing so it commits to falling one way instead of dithering.
      const bias = (tilt - 2.45) / (Math.PI - 2.45);
      ax += Math.cos(this.facing) * bias;
      az += Math.sin(this.facing) * bias;
    }

    _torque.x = ax * UPRIGHT_P - av.x * UPRIGHT_D;
    _torque.z = az * UPRIGHT_P - av.z * UPRIGHT_D;

    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    let dYaw = this.facing - yaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    _torque.y = dYaw * YAW_P - av.y * YAW_D;

    const k = this.mass * dt;
    _torque.x *= k;
    _torque.y *= k;
    _torque.z *= k;
    this.body.applyTorqueImpulse(_torque, true);
  }

  jump(): void {
    if (this.state !== 'up' || this.coyoteMs <= 0 || this.heldBy) return;
    const v = this.body.linvel();
    this.body.setLinvel({ x: v.x, y: JUMP_SPEED, z: v.z }, true);
    this.coyoteMs = 0;
  }

  /* -------------------------------- punch -------------------------------- */

  private updatePunch(
    dtMs: number,
    input: FighterInput,
    peers: readonly Fighter[],
    ev: FighterEvents,
  ): void {
    if (this.punchMs >= 0) {
      this.punchMs += dtMs;
      if (this.punchMs > PUNCH_WINDUP + PUNCH_ACTIVE + PUNCH_RECOVER) this.punchMs = -1;
    }

    if (input.punches > 0 && this.punchMs < 0 && this.state === 'up' && !this.heldBy) {
      this.punchMs = 0;
      this.punchLanded = false;
      // Step into it. A punch thrown from a standstill reads as a twitch; the
      // lunge is what makes the whole body commit to the swing.
      _impulse.x = Math.sin(this.facing) * PUNCH_LUNGE * this.mass;
      _impulse.y = 0;
      _impulse.z = Math.cos(this.facing) * PUNCH_LUNGE * this.mass;
      this.body.applyImpulse(_impulse, true);
      ev.onPunchThrown();
    }

    const active =
      this.punchMs >= PUNCH_WINDUP &&
      this.punchMs <= PUNCH_WINDUP + PUNCH_ACTIVE &&
      !this.punchLanded;
    if (!active) return;

    const me = this.body.translation();
    const fx = Math.sin(this.facing);
    const fz = Math.cos(this.facing);

    for (const other of peers) {
      if (other === this || !other.alive) continue;
      const p = other.body.translation();
      const dx = p.x - me.x;
      const dz = p.z - me.z;
      const dist = Math.hypot(dx, dz);
      if (dist > PUNCH_RANGE || dist < 0.01) continue;
      if (Math.abs(p.y - me.y) > 1.6) continue;
      if ((dx / dist) * fx + (dz / dist) * fz < PUNCH_ARC) continue;

      this.punchLanded = true;
      other.takeHit(dx / dist, dz / dist, PUNCH_IMPULSE, PUNCH_LIFT);

      // Connecting shoves you back, so a landed hit and a whiff differ.
      _impulse.x = (-dx / dist) * PUNCH_RECOIL * this.mass;
      _impulse.y = 0;
      _impulse.z = (-dz / dist) * PUNCH_RECOIL * this.mass;
      this.body.applyImpulse(_impulse, true);

      ev.onHit(1, (me.x + p.x) / 2, (me.y + p.y) / 2 + 0.6, (me.z + p.z) / 2, other.slot);
      return;
    }
  }

  takeHit(dirX: number, dirZ: number, impulse: number, lift: number): void {
    if (this.state === 'out') return;
    this.releaseHold();
    this.heldBy?.releaseHold();

    _impulse.x = dirX * impulse * this.mass;
    _impulse.y = lift * this.mass;
    _impulse.z = dirZ * impulse * this.mass;
    this.body.applyImpulse(_impulse, true);

    // Spin them. Free rotation plus no upright control for the stun duration
    // IS the knockdown — there is no separate ragdoll mode.
    _torque.x = -dirZ * 4.2 * this.mass;
    _torque.y = (Math.random() - 0.5) * 2.0 * this.mass;
    _torque.z = dirX * 4.2 * this.mass;
    this.body.applyTorqueImpulse(_torque, true);

    this.state = 'stunned';
    this.stunMs = STUN_MS + RECOVER_MS;
  }

  /* --------------------------------- grab -------------------------------- */

  private updateGrab(input: FighterInput, peers: readonly Fighter[], ev: FighterEvents): void {
    if (input.grabs <= 0 || this.state !== 'up' || this.heldBy) return;

    if (this.holding) {
      this.throwHeld(ev);
      return;
    }
    this.reachMs = 220;

    const me = this.body.translation();
    const fx = Math.sin(this.facing);
    const fz = Math.cos(this.facing);

    for (const other of peers) {
      if (other === this || !other.alive || other.heldBy) continue;
      const p = other.body.translation();
      const dx = p.x - me.x;
      const dz = p.z - me.z;
      const dist = Math.hypot(dx, dz);
      if (dist > GRAB_RANGE || dist < 0.01) continue;
      if (Math.abs(p.y - me.y) > 1.6) continue;
      if ((dx / dist) * fx + (dz / dist) * fz < GRAB_ARC) continue;

      this.holding = other;
      other.heldBy = this;
      other.holding?.releaseHold();
      ev.onGrab();
      return;
    }
  }

  /**
   * Drag the held fighter to a carry point in front of the chest.
   *
   * A spring, not a joint: joints between two actively controlled bodies fight
   * each other and explode, whereas a damped spring degrades gracefully and
   * still lets the victim struggle.
   */
  private carry(dt: number): void {
    const held = this.holding;
    if (!held || !held.alive) {
      this.releaseHold();
      return;
    }
    const me = this.body.translation();
    const tx = me.x + Math.sin(this.facing) * 1.05;
    const ty = me.y + 0.5;
    const tz = me.z + Math.cos(this.facing) * 1.05;

    const p = held.body.translation();
    const v = held.body.linvel();
    const myV = this.body.linvel();

    _impulse.x = ((tx - p.x) * HOLD_P - (v.x - myV.x) * HOLD_D) * held.mass * dt;
    _impulse.y = ((ty - p.y) * HOLD_P - (v.y - myV.y) * HOLD_D) * held.mass * dt;
    _impulse.z = ((tz - p.z) * HOLD_P - (v.z - myV.z) * HOLD_D) * held.mass * dt;
    held.body.applyImpulse(_impulse, true);
  }

  private throwHeld(ev: FighterEvents): void {
    const held = this.holding;
    if (!held) return;
    const myV = this.body.linvel();
    held.takeHit(Math.sin(this.facing), Math.cos(this.facing), THROW_IMPULSE, THROW_LIFT);
    // Running throws carry further.
    _impulse.x = myV.x * 0.4 * held.mass;
    _impulse.y = 0;
    _impulse.z = myV.z * 0.4 * held.mass;
    held.body.applyImpulse(_impulse, true);
    const victim = held.slot;
    this.releaseHold();
    ev.onThrow(victim);
  }

  releaseHold(): void {
    if (!this.holding) return;
    this.holding.heldBy = null;
    this.holding = null;
  }

  /** Only hard hits tumble you, so brushing past does not start a cascade. */
  onImpact(magnitude: number): void {
    if (magnitude >= 7 && this.state === 'up') {
      this.state = 'stunned';
      this.stunMs = 420;
    }
  }

  /* ------------------------------- lifecycle ----------------------------- */

  private updateGrounded(ev: FighterEvents): void {
    const p = this.body.translation();
    const ray = new this.rapier.Ray({ x: p.x, y: p.y, z: p.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(
      ray,
      HALF_HEIGHT + RADIUS + 0.2,
      true,
      undefined,
      undefined,
      this.collider,
    );
    const wasGrounded = this.grounded;
    this.grounded = hit !== null;

    if (this.grounded) {
      if (!wasGrounded && this.prevVy < -5.5) ev.onLand(Math.min(1, -this.prevVy / 14));
      this.coyoteMs = 110;
    } else {
      this.coyoteMs = Math.max(0, this.coyoteMs - 16);
    }
    this.prevVy = this.body.linvel().y;
  }

  /**
   * `killY` comes from the ARENA, not a module constant: a rooftop's kill plane
   * is fourteen metres down, a walled pit has one only as a physics backstop,
   * and hard-coding either into the fighter would tie it to one level.
   */
  checkFall(killY: number): boolean {
    if (this.state === 'out') return false;
    if (this.body.translation().y >= killY) return false;
    this.eliminate();
    return true;
  }

  eliminate(): void {
    if (this.state === 'out') return;
    this.releaseHold();
    this.heldBy?.releaseHold();
    this.state = 'out';
    this.eliminatedAt = performance.now();
    this.animal.root.visible = false;
    this.body.setEnabled(false);
  }

  respawn(at: { x: number; z: number }): void {
    this.releaseHold();
    this.heldBy?.releaseHold();
    this.state = 'up';
    this.stunMs = 0;
    this.punchMs = -1;
    this.eliminatedAt = null;
    this.animal.root.visible = true;
    this.body.setEnabled(true);
    this.body.setTranslation({ x: at.x, y: 1.2, z: at.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.facing = Math.atan2(-at.x, -at.z);
    this.currPos.set(at.x, 1.2, at.z);
    this.prevPos.copy(this.currPos);
  }

  /* ------------------------------- rendering ----------------------------- */

  /** Drive the limbs. Blended, so transitions come free. */
  private animate(dt: number, moveLen: number): void {
    const j = this.animal.joints;
    const k = Math.min(1, dt * 14);

    if (this.state !== 'up') blendPose(j, (x) => POSES.flail(x, this.animTime), Math.min(1, dt * 18));
    // Wind up, then snap. The snap blends roughly twice as fast as the cock, so
    // the arm whips out of a held pose rather than easing symmetrically through
    // it — that asymmetry is what reads as force.
    else if (this.punchMs >= 0 && this.punchMs < PUNCH_WINDUP)
      blendPose(j, POSES.windup, Math.min(1, dt * 26));
    else if (this.punchMs >= 0 && this.punchMs < PUNCH_WINDUP + PUNCH_ACTIVE)
      blendPose(j, POSES.punch, Math.min(1, dt * 52));
    else if (this.reachMs > 0 || this.holding) blendPose(j, POSES.reach, Math.min(1, dt * 20));
    else if (moveLen > 0.15) blendPose(j, (x) => POSES.run(x, this.animTime), k);
    else blendPose(j, POSES.idle, k);
  }

  captureTransform(): void {
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    const t = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
  }

  /** Interpolate between physics steps so 120Hz displays do not judder. */
  render(alpha: number): void {
    const root = this.animal.root;
    root.position.lerpVectors(this.prevPos, this.currPos, alpha);
    // The capsule's centre is above the feet; drop the model to stand on them.
    root.position.y -= HALF_HEIGHT + RADIUS;
    root.quaternion.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
  }

  dispose(): void {
    this.world.removeRigidBody(this.body);
    this.animal.dispose();
  }
}
