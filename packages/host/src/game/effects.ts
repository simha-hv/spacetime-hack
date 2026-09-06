import * as THREE from 'three';

/**
 * Impact bursts.
 *
 * A landed punch used to produce audio, a freeze and a camera shake — all of
 * which say "something happened" but none of which say WHERE. Watching from
 * across a room you could not tell a connect from a whiff, or which of two
 * animals in a scrum had just been hit. That is the actual complaint behind
 * "I don't understand a lot here".
 *
 * So every hit now draws itself at the contact point: a warm additive flash
 * with a comic starburst punched out on top of it.
 *
 * Sprites rather than ring geometry, deliberately. Sprites always face the
 * camera, which means a flat ring never turns edge-on and vanishes at exactly
 * the moment it matters — and it is one draw call per burst with no per-frame
 * orientation maths.
 *
 * Everything is pooled and pre-allocated. Impacts happen in bursts of four when
 * a pile-up goes off, and allocating a texture mid-frame is how you get a
 * stutter on the one frame the player is looking hardest.
 */

const POOL = 14;
const LIFE_MS = 340;

/** A soft warm bloom, additive. Reads as light, and sits under the star. */
function flashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,244,206,0.85)');
  g.addColorStop(0.68, 'rgba(255,196,86,0.32)');
  g.addColorStop(1, 'rgba(255,170,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * A comic starburst — a spiky POW, drawn with a dark outline.
 *
 * The first version was a soft white shockwave ring, blended additively. On a
 * dark sky it was a faint smudge and over a bright yellow animal it vanished
 * entirely, which is the worst possible behaviour for the one element whose
 * whole job is to say "a hit landed HERE".
 *
 * A filled star with a heavy outline reads on ANY background, needs no bloom
 * to be legible at TV distance, and matches the cartoon art direction far
 * better than a physics-y shockwave did.
 */
function starTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const cx = S / 2;
  const cy = S / 2;
  const points = 11;
  const outer = S * 0.47;
  const inner = S * 0.24;

  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    // Jitter each spike so it looks hand-drawn rather than like a gear.
    const wobble = i % 2 === 0 ? 1 - ((i * 37) % 5) * 0.055 : 1;
    const r = (i % 2 === 0 ? outer : inner) * wobble;
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();

  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.38, '#fff2b0');
  g.addColorStop(1, '#ffb43c');
  ctx.fillStyle = g;
  ctx.fill();

  ctx.lineJoin = 'round';
  ctx.lineWidth = 9;
  ctx.strokeStyle = 'rgba(38,26,18,0.92)';
  ctx.stroke();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Live {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  /** 0..1, elapsed fraction of LIFE_MS. */
  t: number;
  from: number;
  to: number;
  peak: number;
  active: boolean;
}

export class Effects {
  private readonly flashes: Live[] = [];
  private readonly stars: Live[] = [];
  private readonly flashTex = flashTexture();
  private readonly starTex = starTexture();

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < POOL; i++) {
      this.flashes.push(this.make(this.flashTex, THREE.AdditiveBlending, 8));
      // The star draws OVER the flash and is not additive — additive blending
      // is what made it disappear against bright characters.
      this.stars.push(this.make(this.starTex, THREE.NormalBlending, 9));
    }
  }

  private make(map: THREE.Texture, blending: THREE.Blending, order: number): Live {
    const material = new THREE.SpriteMaterial({
      map,
      transparent: true,
      blending,
      // Never occluded. A hit that happens behind a crate is still a hit you
      // need to see, and depth-testing a 300ms cue just loses it.
      depthTest: false,
      depthWrite: false,
      opacity: 0,
    });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = order;
    this.scene.add(sprite);
    return { sprite, material, t: 0, from: 0, to: 1, peak: 1, active: false };
  }

  private take(pool: Live[]): Live | null {
    for (const e of pool) if (!e.active) return e;
    // Everything is busy. Dropping the newest burst is better than stealing a
    // live one — a burst that vanishes mid-animation reads as a glitch.
    return null;
  }

  /**
   * Fire a burst. `power` is 0..1 and scales size and brightness, so a graze
   * and a clean hit look different rather than both flashing identically.
   */
  burst(x: number, y: number, z: number, power: number): void {
    const p = power < 0 ? 0 : power > 1 ? 1 : power;

    const flash = this.take(this.flashes);
    if (flash) {
      flash.sprite.position.set(x, y, z);
      flash.from = 1.35 + p * 1.0;
      flash.to = 0.45;
      flash.peak = 0.8;
      flash.t = 0;
      flash.active = true;
      flash.sprite.visible = true;
    }

    const star = this.take(this.stars);
    if (star) {
      star.sprite.position.set(x, y, z);
      // Punches OUT from small, rather than collapsing in. A star that starts
      // large and shrinks reads as something being absorbed, not delivered.
      star.from = 0.35;
      // Deliberately capped near one character-height. Bigger than this and the
      // burst hides the animal that was hit, which defeats the point of drawing
      // it at the contact position in the first place.
      star.to = 1.05 + p * 0.75;
      star.peak = 1;
      star.t = 0;
      star.active = true;
      star.sprite.visible = true;
    }
  }

  update(dtMs: number): void {
    const step = dtMs / LIFE_MS;
    for (const pool of [this.flashes, this.stars]) {
      for (const e of pool) {
        if (!e.active) continue;
        e.t += step;
        if (e.t >= 1) {
          e.active = false;
          e.sprite.visible = false;
          e.material.opacity = 0;
          continue;
        }
        // Ease out: fast at the start is what makes an impact feel sharp
        // rather than like a slow bloom.
        const k = 1 - (1 - e.t) * (1 - e.t);
        const size = e.from + (e.to - e.from) * k;
        e.sprite.scale.set(size, size, 1);
        // Hold at full opacity for the first third, then drop. Fading from the
        // very first frame means the burst is never actually seen at full
        // strength on a 60Hz display.
        e.material.opacity = e.t < 0.34 ? e.peak : e.peak * (1 - (e.t - 0.34) / 0.66);
      }
    }
  }

  /** Clear everything, for a new round. */
  reset(): void {
    for (const pool of [this.flashes, this.stars]) {
      for (const e of pool) {
        e.active = false;
        e.sprite.visible = false;
        e.material.opacity = 0;
      }
    }
  }

  dispose(): void {
    for (const pool of [this.flashes, this.stars]) {
      for (const e of pool) {
        this.scene.remove(e.sprite);
        e.material.dispose();
      }
    }
    this.flashTex.dispose();
    this.starTex.dispose();
  }
}
