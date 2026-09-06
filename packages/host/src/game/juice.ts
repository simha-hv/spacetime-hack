/**
 * Hit-stop and camera shake.
 *
 * Two of the cheapest, highest-yield tools in game feel: freezing the
 * simulation for a few frames on a solid hit makes it land, and a short
 * positional shake sells the weight. Neither costs anything measurable.
 */

/** Hard caps so a pile-up cannot stack into an unresponsive freeze. */
const MAX_HITSTOP_MS = 110;
const MAX_SHAKE = 0.55;

export class Juice {
  /** Remaining freeze, ms. While > 0 the physics step is skipped. */
  private hitstopMs = 0;
  /** Current shake amplitude in world units, decaying. */
  private shake = 0;

  /** Reused so the render loop never allocates. */
  readonly shakeOffset = { x: 0, y: 0, z: 0 };

  /**
   * Register an impact. `power` is 0..1.
   *
   * Takes the max rather than summing: four simultaneous hits should feel like
   * one big hit, not lock the game up for half a second.
   */
  impact(power: number): void {
    const p = power < 0 ? 0 : power > 1 ? 1 : power;
    this.hitstopMs = Math.max(this.hitstopMs, 34 + p * (MAX_HITSTOP_MS - 34));
    this.shake = Math.max(this.shake, 0.12 + p * (MAX_SHAKE - 0.12));
  }

  /** True while the simulation should hold still. */
  get frozen(): boolean {
    return this.hitstopMs > 0;
  }

  /** Advance timers. Called every frame, even while frozen. */
  update(frameMs: number): void {
    if (this.hitstopMs > 0) this.hitstopMs -= frameMs;

    if (this.shake > 0.001) {
      // Decay fast: shake that outlives the impact reads as a rumble.
      this.shake *= Math.exp(-frameMs / 90);
      this.shakeOffset.x = (Math.random() * 2 - 1) * this.shake;
      this.shakeOffset.y = (Math.random() * 2 - 1) * this.shake * 0.7;
      this.shakeOffset.z = (Math.random() * 2 - 1) * this.shake * 0.4;
    } else {
      this.shake = 0;
      this.shakeOffset.x = 0;
      this.shakeOffset.y = 0;
      this.shakeOffset.z = 0;
    }
  }

  reset(): void {
    this.hitstopMs = 0;
    this.shake = 0;
    this.shakeOffset.x = 0;
    this.shakeOffset.y = 0;
    this.shakeOffset.z = 0;
  }
}
