import * as THREE from 'three';

/**
 * Floating name labels.
 *
 * Four identical plush animals in different colours are hard to tell apart
 * once they are tumbling, and "which one am I" is the single most common
 * confusion in a four-player party game. A label above the head fixes it.
 *
 * Drawn into a small canvas texture rather than rendered as geometry: one
 * sprite, one draw call, and it only repaints when the name changes.
 */

const W = 256;
const H = 88;
/** Where the label ends and the health bar begins. */
const LABEL_H = 60;

export interface NameTag {
  sprite: THREE.Sprite;
  setLabel(name: string, color: string): void;
  /**
   * 0..1, or null for a game with no health system.
   *
   * The bar lives on the tag rather than in the corner of the screen because
   * with four players you need to know whose health you are looking at, and a
   * bar attached to the animal answers that without a legend.
   */
  setHealth(fraction: number | null): void;
  dispose(): void;
}

export function makeNameTag(name: string, color: string): NameTag {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Labels are viewed at a shallow angle across the arena; without anisotropy
  // the far ones turn to mush.
  texture.anisotropy = 4;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    // Always readable, even through an AC unit. A name tag that hides behind
    // scenery is worse than useless — you look for it and it is not there.
    depthTest: false,
    depthWrite: false,
  });

  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.6, (1.6 * H) / W, 1);
  // Sprites render in the transparent pass; force them last so they never
  // z-fight with each other.
  sprite.renderOrder = 10;

  let currentName = name;
  let currentColor = color;
  let currentHealth: number | null = null;

  const draw = (): void => {
    ctx.clearRect(0, 0, W, H);

    const text = currentName.slice(0, 14) || '…';
    ctx.font = 'bold 34px system-ui, sans-serif';
    const textW = Math.min(ctx.measureText(text).width, W - 34);
    const padded = textW + 30;
    const x = (W - padded) / 2;

    ctx.fillStyle = 'rgba(12,14,22,0.72)';
    roundRect(ctx, x, 6, padded, LABEL_H - 12, 14);
    ctx.fill();
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, LABEL_H / 2, W - 34);

    if (currentHealth !== null) {
      const bw = 168;
      const bh = 15;
      const bx = (W - bw) / 2;
      const by = LABEL_H + 3;

      ctx.fillStyle = 'rgba(12,14,22,0.85)';
      roundRect(ctx, bx, by, bw, bh, 7);
      ctx.fill();

      const f = Math.max(0, Math.min(1, currentHealth));
      if (f > 0) {
        // Green through amber to red. Colour is the fastest read there is at
        // TV distance — you should know someone is nearly out without
        // measuring the length of their bar against anyone else's.
        ctx.fillStyle = f > 0.5 ? '#3ddc84' : f > 0.22 ? '#ffd23d' : '#ff4d4d';
        roundRect(ctx, bx + 2, by + 2, Math.max(6, (bw - 4) * f), bh - 4, 5);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      roundRect(ctx, bx, by, bw, bh, 7);
      ctx.stroke();
    }

    texture.needsUpdate = true;
  };

  draw();

  return {
    sprite,
    setLabel(label: string, hex: string): void {
      currentName = label;
      currentColor = hex;
      draw();
    },
    setHealth(fraction: number | null): void {
      // Repaint only when the visible bar actually moves — this is a canvas
      // upload to the GPU, and doing it every frame for four players is real
      // work for a bar that changes a few times a round.
      const q = fraction === null ? null : Math.round(Math.max(0, fraction) * 40) / 40;
      if (q === currentHealth) return;
      currentHealth = q;
      draw();
    },
    dispose(): void {
      texture.dispose();
      material.dispose();
    },
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
