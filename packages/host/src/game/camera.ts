import * as THREE from 'three';

/**
 * A dynamic chase camera that frames whoever is still alive.
 *
 * The rule is simple: never cut anyone off. It finds the bounding box of the
 * live players, aims at its centre and pulls back far enough that the box fits
 * inside the frustum with margin, then smooths toward that.
 *
 * The fit must consider BOTH axes. Computing distance from the vertical FOV
 * alone works until the fight spreads sideways on a 21:9 TV, at which point
 * the horizontal extent is the binding constraint and players slide off the
 * left and right edges while the camera insists everything is fine.
 */

const MIN_DIST = 10;
const MAX_DIST = 26;
/** Extra room around the players so nobody is ever hard against the edge. */
const MARGIN = 1.4;
/** Fixed angle. A camera that changes pitch as well as distance is nauseating. */
const PITCH = 0.62;
const HEIGHT_BIAS = 0.5;

/**
 * How tall a player is, plus the name tag floating above them.
 *
 * The solver is fed body POSITIONS, which sit near the feet. Framing those
 * alone puts the player at the bottom edge of the screen and crops their head
 * and label clean off — which is precisely what it did.
 */
const BODY_HEIGHT = 2.6;

export class ChaseCamera {
  private readonly target = new THREE.Vector3(0, 2, 0);
  private readonly look = new THREE.Vector3(0, 2, 0);
  private dist = 20;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /** Snap to the current framing, for the start of a round. */
  snap(points: readonly { x: number; y: number; z: number }[]): void {
    this.solve(points);
    this.look.copy(this.target);
    this.place({ x: 0, y: 0, z: 0 });
  }

  update(
    points: readonly { x: number; y: number; z: number }[],
    dt: number,
    shake: { x: number; y: number; z: number },
  ): void {
    this.solve(points);
    // Critically-damped-ish exponential smoothing, frame-rate independent.
    // A plain lerp with a constant factor drifts with refresh rate: the same
    // number feels sluggish at 60Hz and twitchy at 144Hz.
    const k = 1 - Math.exp(-dt * 3.4);
    this.look.lerp(this.target, k);
    this.place(shake);
  }

  private solve(points: readonly { x: number; y: number; z: number }[]): void {
    if (points.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }

    // Grow the box upward to cover the bodies and their labels, not just the
    // points at their feet.
    maxY += BODY_HEIGHT;

    this.target.set((minX + maxX) / 2, (minY + maxY) / 2 + HEIGHT_BIAS, (minZ + maxZ) / 2);

    /*
     * Exact fit, in camera space.
     *
     * The pitch is fixed, so the camera basis is constant and a point's
     * horizontal and vertical camera-space offsets do not depend on the
     * distance at all — only its DEPTH does, and linearly:
     *
     *   x' = p.x - look.x
     *   y' = cos(PITCH)·dy - sin(PITCH)·dz
     *   depth = d - (sin(PITCH)·dy + cos(PITCH)·dz)
     *
     * The point is on screen when |x'| ≤ tan(hFov/2)·depth and likewise for y,
     * so the distance each point NEEDS is closed-form and the answer is simply
     * the largest of them. No iteration and no approximation.
     *
     * The previous version fitted a world-space bounding box against the FOV
     * instead. That silently ignores perspective — the near player subtends far
     * more of the frame than the far one — so whoever was closest to the camera
     * got cropped off the bottom of the screen while the maths insisted the box
     * fitted comfortably.
     */
    const vFov = (this.camera.fov * Math.PI) / 180;
    const tanV = Math.tan(vFov / 2);
    const tanH = tanV * this.camera.aspect;
    const sinP = Math.sin(PITCH);
    const cosP = Math.cos(PITCH);

    let want = MIN_DIST;
    for (const p of points) {
      // Test the feet and the top of the head; both have to be inside.
      for (const y of [p.y, p.y + BODY_HEIGHT]) {
        const dx = p.x - this.target.x;
        const dy = y - this.target.y;
        const dz = p.z - this.target.z;

        // Depth at distance d is `d - behind`.
        const behind = sinP * dy + cosP * dz;
        const yCam = cosP * dy - sinP * dz;

        const needV = (Math.abs(yCam) + MARGIN) / tanV + behind;
        const needH = (Math.abs(dx) + MARGIN) / tanH + behind;
        if (needV > want) want = needV;
        if (needH > want) want = needH;
      }
    }

    this.dist += (Math.min(MAX_DIST, want) - this.dist) * 0.06;
  }

  private place(shake: { x: number; y: number; z: number }): void {
    const back = Math.cos(PITCH) * this.dist;
    const up = Math.sin(PITCH) * this.dist;
    this.camera.position.set(
      this.look.x + shake.x,
      this.look.y + up + shake.y,
      this.look.z + back + shake.z,
    );
    this.camera.lookAt(this.look.x, this.look.y, this.look.z);
  }
}
