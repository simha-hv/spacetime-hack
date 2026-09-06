/**
 * The character roster, built from primitives.
 *
 * Everything so far has been a capsule with a dot on it, which is why none of
 * the visual studies had any charm — the renderer was never the problem.
 *
 * Design rules these all follow:
 *  - Head bigger than the body. Chibi proportions read at TV distance and are
 *    what make a character look like a toy rather than a placeholder.
 *  - Silhouette first. Ears, snout, tail and horns are the only thing you can
 *    actually tell apart from across a room, so every species differs there.
 *  - Player colour on the BODY, never on the details. Cream muzzles, white
 *    eyes and dark noses stay constant so all four players read as the same
 *    species family in four colours rather than four unrelated blobs.
 */

import * as THREE from './three.module.js';

/* ------------------------------- palette -------------------------------- */

const CREAM = '#fff3e2';
const DARK = '#2f2a34';
const PINK = '#ffb3bd';

/** Shared geometry — a roster of 10 costs a handful of geometries, not 60. */
const G = {
  sphere: new THREE.SphereGeometry(1, 22, 18),
  capsule: new THREE.CapsuleGeometry(1, 1, 8, 20),
  cone: new THREE.ConeGeometry(1, 1, 16),
  box: new THREE.BoxGeometry(1, 1, 1),
  torus: new THREE.TorusGeometry(1, 0.25, 10, 24),
};

const matCache = new Map();
function mat(color, opts = {}) {
  const key = `${color}|${opts.rough ?? 0.9}|${opts.metal ?? 0}|${opts.emissive ?? ''}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: opts.rough ?? 0.9,
      metalness: opts.metal ?? 0,
      ...(opts.emissive ? { emissive: new THREE.Color(opts.emissive), emissiveIntensity: 0.6 } : {}),
    });
    matCache.set(key, m);
  }
  return m;
}

/** Add a primitive. `s` is scale, `p` position, `r` rotation. */
function add(parent, geo, material, p, s, r) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(p[0], p[1], p[2]);
  m.scale.set(s[0], s[1], s[2]);
  if (r) m.rotation.set(r[0], r[1], r[2]);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/* ------------------------------ shared parts ----------------------------- */

/** Eyes + optional brows. Every character gets the same eyes: it is the glue. */
function face(g, { y = 0.52, spread = 0.24, size = 1, z = 0.62, angry = false } = {}) {
  for (const s of [-1, 1]) {
    add(g, G.sphere, mat(CREAM, { rough: 0.45 }), [s * spread, y, z], [0.13 * size, 0.16 * size, 0.09]);
    add(g, G.sphere, mat(DARK, { rough: 0.3 }), [s * spread * 1.04, y, z + 0.06], [0.07 * size, 0.085 * size, 0.05]);
    if (angry) {
      add(g, G.box, mat(DARK), [s * spread, y + 0.17 * size, z + 0.03], [0.17 * size, 0.045, 0.05], [0, 0, s * 0.42]);
    }
  }
}

/** Stubby arms and feet, so the body has weight and something to punch with. */
function limbs(g, body, { armY = 0.02, armX = 0.46, footX = 0.2, footZ = 0.16 } = {}) {
  for (const s of [-1, 1]) {
    add(g, G.sphere, body, [s * armX, armY, 0.06], [0.17, 0.16, 0.17]);
    add(g, G.sphere, body, [s * footX, -0.62, footZ], [0.19, 0.12, 0.24]);
  }
}

/** A rounded body with a cream belly patch. The base of nearly everyone. */
function torso(g, body, { w = 0.42, h = 0.42, belly = true } = {}) {
  add(g, G.capsule, body, [0, 0, 0], [w, h, w]);
  if (belly) add(g, G.sphere, mat(CREAM), [0, -0.1, 0.3], [0.26, 0.3, 0.12]);
}

/* -------------------------------- roster --------------------------------- */

/**
 * Each builder returns a THREE.Group standing on y = 0, roughly 1.6 tall.
 * `color` is the player colour.
 */
export const CHARACTERS = [
  {
    id: 'pup',
    name: 'Pup',
    note: 'Floppy ears, big snout. The friendliest silhouette.',
    build(color) {
      const g = new THREE.Group();
      const body = mat(color);
      torso(g, body);
      add(g, G.sphere, body, [0, 0.5, 0], [0.52, 0.48, 0.5]);
      // Muzzle + nose.
      add(g, G.sphere, mat(CREAM), [0, 0.38, 0.42], [0.24, 0.18, 0.2]);
      add(g, G.sphere, mat(DARK), [0, 0.44, 0.58], [0.09, 0.07, 0.07]);
      // Floppy ears hanging down the sides.
      for (const s of [-1, 1]) {
        add(g, G.capsule, mat(color, { rough: 0.95 }), [s * 0.46, 0.42, 0], [0.13, 0.2, 0.09], [0, 0, s * 0.25]);
      }
      add(g, G.capsule, body, [0, -0.18, -0.42], [0.09, 0.14, 0.09], [0.9, 0, 0]);
      face(g, { y: 0.6, spread: 0.19, z: 0.44 });
      limbs(g, body);
      return g;
    },
  },
  {
    id: 'kit',
    name: 'Kit',
    note: 'Sharp triangle ears and a long tail. Reads as sly.',
    build(color) {
      const g = new THREE.Group();
      const body = mat(color);
      torso(g, body);
      add(g, G.sphere, body, [0, 0.5, 0], [0.48, 0.46, 0.47]);
      for (const s of [-1, 1]) {
        add(g, G.cone, mat(color), [s * 0.28, 0.92, 0], [0.17, 0.34, 0.14]);
        add(g, G.cone, mat(PINK), [s * 0.28, 0.9, 0.05], [0.1, 0.24, 0.08]);
      }
      add(g, G.sphere, mat(CREAM), [0, 0.4, 0.4], [0.18, 0.13, 0.16]);
      add(g, G.sphere, mat(PINK), [0, 0.45, 0.52], [0.06, 0.05, 0.05]);
      // Tail curling up behind.
      add(g, G.capsule, mat(color), [0.05, -0.05, -0.45], [0.08, 0.3, 0.08], [0.7, 0, 0.3]);
      face(g, { y: 0.58, spread: 0.2, z: 0.42, angry: true });
      limbs(g, body);
      return g;
    },
  },
  {
    id: 'bun',
    name: 'Bun',
    note: 'Tall ears — the tallest silhouette, impossible to mistake.',
    build(color) {
      const g = new THREE.Group();
      const body = mat(color);
      torso(g, body, { w: 0.4, h: 0.44 });
      add(g, G.sphere, body, [0, 0.5, 0], [0.46, 0.46, 0.45]);
      for (const s of [-1, 1]) {
        add(g, G.capsule, mat(color), [s * 0.17, 1.06, -0.02], [0.1, 0.26, 0.07], [0, 0, s * 0.13]);
        add(g, G.capsule, mat(PINK), [s * 0.17, 1.06, 0.03], [0.06, 0.2, 0.04], [0, 0, s * 0.13]);
      }
      add(g, G.sphere, mat(CREAM), [0, 0.4, 0.4], [0.16, 0.12, 0.14]);
      add(g, G.sphere, mat(PINK), [0, 0.45, 0.5], [0.05, 0.045, 0.04]);
      add(g, G.sphere, mat(CREAM), [0, -0.2, -0.42], [0.14, 0.14, 0.1]);
      face(g, { y: 0.56, spread: 0.2, z: 0.42 });
      limbs(g, body);
      return g;
    },
  },
  {
    id: 'cub',
    name: 'Cub',
    note: 'Widest and heaviest. Round ears, looks like it hits hard.',
    build(color) {
      const g = new THREE.Group();
      const body = mat(color);
      torso(g, body, { w: 0.5, h: 0.4 });
      add(g, G.sphere, body, [0, 0.48, 0], [0.54, 0.5, 0.52]);
      for (const s of [-1, 1]) add(g, G.sphere, mat(color), [s * 0.38, 0.86, -0.04], [0.16, 0.16, 0.1]);
      add(g, G.sphere, mat(CREAM), [0, 0.36, 0.44], [0.26, 0.19, 0.2]);
      add(g, G.sphere, mat(DARK), [0, 0.42, 0.6], [0.1, 0.08, 0.07]);
      face(g, { y: 0.58, spread: 0.22, z: 0.46, angry: true });
      limbs(g, body, { armX: 0.54, footX: 0.24 });
      return g;
    },
  },
  {
    id: 'quack',
    name: 'Quack',
    note: 'Flat beak and side wings. The only one with a hard edge.',
    build(color) {
      const g = new THREE.Group();
      const body = mat(color);
      torso(g, body, { w: 0.42, h: 0.44 });
      add(g, G.sphere, body, [0, 0.52, 0], [0.44, 0.44, 0.44]);
      // Beak: two flattened boxes, slightly open.
      add(g, G.box, mat('#ffb638'), [0, 0.44, 0.5], [0.3, 0.09, 0.34]);
      add(g, G.box, mat('#e89422'), [0, 0.36, 0.48], [0.26, 0.06, 0.28]);
      for (const s of [-1, 1]) {
        add(g, G.capsule, mat(color), [s * 0.46, -0.02, -0.02], [0.09, 0.22, 0.16], [0, 0, s * 0.3]);
      }
      for (const s of [-1, 1]) add(g, G.sphere, mat('#ffb638'), [s * 0.2, -0.62, 0.18], [0.2, 0.09, 0.26]);
      face(g, { y: 0.62, spread: 0.2, z: 0.38 });
      return g;
    },
  },
  {
    id: 'ribbit',
    name: 'Ribbit',
    note: 'Eyes on top of the head. Squat and wide — a low silhouette.',
    build(color) {
      const g = new THREE.Group();
      const body = mat(color);
      add(g, G.capsule, body, [0, -0.05, 0], [0.5, 0.34, 0.46]);
      add(g, G.sphere, mat(CREAM), [0, -0.12, 0.32], [0.3, 0.26, 0.14]);
      add(g, G.sphere, body, [0, 0.36, 0.02], [0.5, 0.36, 0.46]);
      // Eyes perched on domes on top.
      for (const s of [-1, 1]) {
        add(g, G.sphere, mat(color), [s * 0.26, 0.66, 0.04], [0.19, 0.19, 0.19]);
        add(g, G.sphere, mat(CREAM, { rough: 0.4 }), [s * 0.26, 0.72, 0.1], [0.13, 0.13, 0.1]);
        add(g, G.sphere, mat(DARK, { rough: 0.3 }), [s * 0.26, 0.73, 0.18], [0.07, 0.08, 0.05]);
      }
      // A wide mouth line.
      add(g, G.box, mat(DARK), [0, 0.24, 0.44], [0.3, 0.035, 0.04]);
      for (const s of [-1, 1]) {
        add(g, G.sphere, body, [s * 0.5, -0.12, 0.02], [0.16, 0.14, 0.18]);
        add(g, G.sphere, body, [s * 0.3, -0.5, 0.14], [0.22, 0.12, 0.3]);
      }
      return g;
    },
  },
  {
    id: 'tusk',
    name: 'Tusk',
    note: 'Horns and a snout. The heavy, and the only aggressive read.',
    build(color) {
      const g = new THREE.Group();
      const body = mat(color);
      torso(g, body, { w: 0.52, h: 0.4, belly: false });
      add(g, G.sphere, mat(CREAM), [0, -0.08, 0.34], [0.3, 0.28, 0.14]);
      add(g, G.sphere, body, [0, 0.46, 0], [0.52, 0.44, 0.5]);
      add(g, G.sphere, mat(CREAM), [0, 0.34, 0.44], [0.28, 0.2, 0.2]);
      for (const s of [-1, 1]) add(g, G.sphere, mat(DARK), [s * 0.1, 0.38, 0.58], [0.06, 0.07, 0.05]);
      // Horns sweeping up and out.
      for (const s of [-1, 1]) {
        add(g, G.cone, mat('#f3e6cf'), [s * 0.42, 0.74, 0.06], [0.11, 0.3, 0.11], [0.2, 0, s * 0.7]);
      }
      face(g, { y: 0.56, spread: 0.23, z: 0.44, angry: true });
      limbs(g, body, { armX: 0.56, footX: 0.24 });
      return g;
    },
  },
  {
    id: 'bolt',
    name: 'Bolt',
    note: 'Boxy robot with an antenna. Non-animal option.',
    build(color) {
      const g = new THREE.Group();
      const body = mat(color, { rough: 0.5, metal: 0.25 });
      add(g, G.box, body, [0, -0.02, 0], [0.72, 0.78, 0.6]);
      add(g, G.box, mat('#cfd6e2', { rough: 0.4, metal: 0.35 }), [0, -0.06, 0.31], [0.4, 0.4, 0.06]);
      add(g, G.box, body, [0, 0.62, 0], [0.78, 0.6, 0.66]);
      // Visor rather than eyes — different enough to be a real alternative.
      add(g, G.box, mat(DARK, { rough: 0.2 }), [0, 0.66, 0.34], [0.62, 0.24, 0.05]);
      for (const s of [-1, 1]) {
        add(g, G.sphere, mat('#7ef0ff', { emissive: '#7ef0ff', rough: 0.3 }), [s * 0.16, 0.66, 0.37], [0.07, 0.08, 0.03]);
        add(g, G.box, body, [s * 0.5, 0.0, 0], [0.18, 0.34, 0.24]);
        add(g, G.box, mat('#cfd6e2', { rough: 0.5, metal: 0.3 }), [s * 0.22, -0.6, 0.06], [0.24, 0.16, 0.34]);
      }
      add(g, G.capsule, mat('#cfd6e2', { metal: 0.4 }), [0, 1.0, 0], [0.035, 0.12, 0.035]);
      add(g, G.sphere, mat('#ff5f6d', { emissive: '#ff5f6d' }), [0, 1.16, 0], [0.09, 0.09, 0.09]);
      return g;
    },
  },
  {
    id: 'blob',
    name: 'Blob',
    note: 'No limbs at all. The simplest possible read, and very squashable.',
    build(color) {
      const g = new THREE.Group();
      const body = mat(color, { rough: 0.75 });
      add(g, G.sphere, body, [0, 0.06, 0], [0.62, 0.66, 0.6]);
      // A drip skirt so it reads as gooey rather than as a ball.
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        add(g, G.sphere, body, [Math.cos(a) * 0.5, -0.5, Math.sin(a) * 0.48], [0.16, 0.12, 0.16]);
      }
      add(g, G.sphere, body, [0, -0.5, 0], [0.6, 0.14, 0.58]);
      add(g, G.sphere, mat('#ffffff', { rough: 0.1 }), [-0.24, 0.34, 0.36], [0.12, 0.09, 0.05], [0, 0, 0.5]);
      face(g, { y: 0.16, spread: 0.24, z: 0.55, size: 1.2 });
      add(g, G.torus, mat(DARK), [0, -0.08, 0.54], [0.09, 0.09, 0.05], [0, 0, 0]);
      return g;
    },
  },
  {
    id: 'spud',
    name: 'Spud',
    note: 'A potato with legs. Deliberately the dumbest one here.',
    build(color) {
      const g = new THREE.Group();
      const body = mat(color, { rough: 1 });
      add(g, G.sphere, body, [0, 0.08, 0], [0.5, 0.7, 0.48], [0.12, 0, 0.1]);
      add(g, G.sphere, body, [0.16, 0.3, 0.1], [0.3, 0.28, 0.3]);
      add(g, G.sphere, body, [-0.2, -0.1, -0.06], [0.26, 0.26, 0.26]);
      for (const s of [-1, 1]) {
        add(g, G.capsule, mat(DARK), [s * 0.34, -0.62, 0.02], [0.05, 0.12, 0.05]);
        add(g, G.sphere, mat('#ffb638'), [s * 0.34, -0.84, 0.1], [0.15, 0.08, 0.2]);
        add(g, G.sphere, body, [s * 0.46, 0.14, 0.04], [0.14, 0.13, 0.14]);
      }
      face(g, { y: 0.36, spread: 0.19, z: 0.44 });
      add(g, G.torus, mat(DARK), [0, 0.12, 0.44], [0.08, 0.06, 0.06]);
      return g;
    },
  },
];

export { G, mat, CREAM, DARK };
