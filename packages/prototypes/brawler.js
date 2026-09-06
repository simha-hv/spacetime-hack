/**
 * Rigged brawler characters.
 *
 * The previous roster was a mistake: charming shapes with no arms and no legs.
 * A legless egg cannot punch, cannot grab, and cannot ragdoll — which is the
 * entire game. Party Animals works because every character is a jointed body
 * whose limbs flail independently.
 *
 * So each character here is a HIERARCHY, not a blob:
 *
 *   root
 *    └ hips ── thighL/R ── shinL/R ── footL/R
 *       └ chest ── shoulderL/R ── forearmL/R ── handL/R
 *          └ neck ── head ── (ears, snout, horns — the species)
 *
 * Every joint is a named pivot, so the same body can be posed for a stance,
 * a thrown punch, a grab, or dumped into a heap when knocked out. The species
 * differences live only in the head and a tail; the skeleton is shared.
 */

import * as THREE from './three.module.js';

const CREAM = '#fff4e6';
const DARK = '#332d38';
const PINK = '#ffb0bb';

const G = {
  sphere: new THREE.SphereGeometry(1, 20, 16),
  capsule: new THREE.CapsuleGeometry(1, 1, 6, 16),
  cone: new THREE.ConeGeometry(1, 1, 14),
  box: new THREE.BoxGeometry(1, 1, 1),
};

const matCache = new Map();
function mat(color, rough = 0.95, metal = 0) {
  const key = `${color}|${rough}|${metal}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: rough,
      metalness: metal,
    });
    matCache.set(key, m);
  }
  return m;
}

function part(parent, geo, material, p, s, r) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(p[0], p[1], p[2]);
  m.scale.set(s[0], s[1], s[2]);
  if (r) m.rotation.set(r[0], r[1], r[2]);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** An empty pivot at a joint location. */
function joint(parent, p) {
  const g = new THREE.Group();
  g.position.set(p[0], p[1], p[2]);
  parent.add(g);
  return g;
}

/* ---------------------------- proportions -------------------------------- */

/*
 * Short thick limbs and an oversized head. These are toy proportions on
 * purpose: long limbs read as human and look wrong flailing, while stubby
 * ones look funny and stay legible when the whole body is tumbling.
 */
const P = {
  hipY: 0.74,
  chestY: 0.30,
  headY: 0.44,
  shoulderX: 0.34,
  shoulderY: 0.20,
  upperArm: 0.24,
  foreArm: 0.22,
  handR: 0.145,
  hipX: 0.19,
  thigh: 0.24,
  shin: 0.22,
};

/** Eyes — identical across every species; they are what unify the cast. */
function eyes(head, { spread = 0.2, y = 0.06, z = 0.36, size = 1, brows = false } = {}) {
  for (const s of [-1, 1]) {
    part(head, G.sphere, mat(CREAM, 0.4), [s * spread, y, z], [0.13 * size, 0.155 * size, 0.09]);
    part(head, G.sphere, mat(DARK, 0.25), [s * spread * 1.05, y, z + 0.055], [0.068 * size, 0.082 * size, 0.05]);
    if (brows) {
      part(head, G.box, mat(DARK), [s * spread, y + 0.16 * size, z + 0.02], [0.16 * size, 0.04, 0.05], [0, 0, s * 0.4]);
    }
  }
}

/* ------------------------------- species --------------------------------- */

/** Each returns nothing; it decorates the head/body it is handed. */
const SPECIES = {
  pup(head, body, color) {
    part(head, G.sphere, mat(CREAM), [0, -0.08, 0.3], [0.19, 0.14, 0.16]);
    part(head, G.sphere, mat(DARK), [0, -0.03, 0.44], [0.075, 0.06, 0.06]);
    for (const s of [-1, 1]) {
      part(head, G.capsule, mat(color), [s * 0.33, -0.02, -0.02], [0.1, 0.15, 0.07], [0, 0, s * 0.22]);
    }
    eyes(head, { spread: 0.17, y: 0.1, z: 0.32 });
  },
  kit(head, body, color) {
    for (const s of [-1, 1]) {
      part(head, G.cone, mat(color), [s * 0.21, 0.36, 0], [0.14, 0.26, 0.11]);
      part(head, G.cone, mat(PINK), [s * 0.21, 0.34, 0.04], [0.08, 0.18, 0.06]);
    }
    part(head, G.sphere, mat(CREAM), [0, -0.07, 0.29], [0.14, 0.1, 0.13]);
    part(head, G.sphere, mat(PINK), [0, -0.02, 0.4], [0.05, 0.04, 0.04]);
    eyes(head, { spread: 0.18, y: 0.09, z: 0.31, brows: true });
  },
  bun(head, body, color) {
    for (const s of [-1, 1]) {
      part(head, G.capsule, mat(color), [s * 0.13, 0.54, -0.02], [0.08, 0.22, 0.055], [0, 0, s * 0.11]);
      part(head, G.capsule, mat(PINK), [s * 0.13, 0.54, 0.02], [0.05, 0.16, 0.03], [0, 0, s * 0.11]);
    }
    part(head, G.sphere, mat(CREAM), [0, -0.07, 0.3], [0.13, 0.1, 0.12]);
    part(head, G.sphere, mat(PINK), [0, -0.02, 0.4], [0.045, 0.04, 0.035]);
    eyes(head, { spread: 0.18, y: 0.09, z: 0.32 });
  },
  cub(head, body, color) {
    for (const s of [-1, 1]) part(head, G.sphere, mat(color), [s * 0.3, 0.3, -0.03], [0.13, 0.13, 0.08]);
    part(head, G.sphere, mat(CREAM), [0, -0.09, 0.31], [0.2, 0.15, 0.16]);
    part(head, G.sphere, mat(DARK), [0, -0.03, 0.45], [0.08, 0.065, 0.06]);
    eyes(head, { spread: 0.19, y: 0.1, z: 0.33, brows: true });
  },
  quack(head, body, color) {
    part(head, G.box, mat('#ffb638'), [0, -0.06, 0.38], [0.26, 0.08, 0.3]);
    part(head, G.box, mat('#e89422'), [0, -0.13, 0.36], [0.22, 0.05, 0.25]);
    eyes(head, { spread: 0.18, y: 0.12, z: 0.28 });
  },
  tusk(head, body, color) {
    part(head, G.sphere, mat(CREAM), [0, -0.09, 0.33], [0.22, 0.16, 0.17]);
    for (const s of [-1, 1]) part(head, G.sphere, mat(DARK), [s * 0.08, -0.05, 0.47], [0.05, 0.055, 0.04]);
    for (const s of [-1, 1]) {
      part(head, G.cone, mat('#f5ead4'), [s * 0.17, -0.12, 0.36], [0.05, 0.16, 0.05], [-0.5, 0, s * 0.3]);
      part(head, G.sphere, mat(color), [s * 0.33, 0.26, -0.02], [0.1, 0.11, 0.07]);
    }
    eyes(head, { spread: 0.2, y: 0.11, z: 0.33, brows: true });
  },
};

/* ------------------------------ the builder ------------------------------ */

/**
 * Build a rigged brawler.
 * @returns {{ root: THREE.Group, joints: object }}
 */
export function buildBrawler(speciesId, color) {
  const skin = mat(color);
  const root = new THREE.Group();

  const hips = joint(root, [0, P.hipY, 0]);
  part(hips, G.sphere, skin, [0, -0.04, 0], [0.3, 0.24, 0.26]);

  const chest = joint(hips, [0, P.chestY, 0]);
  part(chest, G.capsule, skin, [0, -0.05, 0], [0.33, 0.16, 0.3]);
  // Belly patch: breaks up the colour and gives the torso a front.
  part(chest, G.sphere, mat(CREAM), [0, -0.1, 0.24], [0.2, 0.2, 0.09]);

  const neck = joint(chest, [0, P.headY, 0]);
  const head = joint(neck, [0, 0, 0]);
  part(head, G.sphere, skin, [0, 0, 0], [0.42, 0.4, 0.4]);
  (SPECIES[speciesId] ?? SPECIES.pup)(head, skin, color);

  const joints = { root, hips, chest, neck, head, arms: {}, legs: {} };

  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;

    const shoulder = joint(chest, [s * P.shoulderX, P.shoulderY, 0]);
    part(shoulder, G.capsule, skin, [0, -P.upperArm / 2, 0], [0.12, P.upperArm / 2, 0.12]);
    const elbow = joint(shoulder, [0, -P.upperArm, 0]);
    part(elbow, G.capsule, skin, [0, -P.foreArm / 2, 0], [0.11, P.foreArm / 2, 0.11]);
    // Mitten hands: one round shape, no fingers. Reads as a fist at distance.
    const hand = joint(elbow, [0, -P.foreArm, 0]);
    part(hand, G.sphere, skin, [0, 0, 0], [P.handR, P.handR, P.handR]);
    joints.arms[side] = { shoulder, elbow, hand };

    const hip = joint(hips, [s * P.hipX, -0.12, 0]);
    part(hip, G.capsule, skin, [0, -P.thigh / 2, 0], [0.135, P.thigh / 2, 0.135]);
    const knee = joint(hip, [0, -P.thigh, 0]);
    part(knee, G.capsule, skin, [0, -P.shin / 2, 0], [0.12, P.shin / 2, 0.12]);
    const foot = joint(knee, [0, -P.shin, 0]);
    part(foot, G.sphere, skin, [0, -0.02, 0.06], [0.16, 0.1, 0.21]);
    joints.legs[side] = { hip, knee, foot };
  }

  return { root, joints };
}

/* --------------------------------- poses --------------------------------- */

const set = (j, x, y, z) => j.rotation.set(x, y ?? 0, z ?? 0);

/**
 * Poses the game actually needs. Each is the same rig — proof the body can do
 * the job, which a static blob never could.
 */
export const POSES = {
  stance(j) {
    set(j.hips, 0, 0, 0);
    set(j.chest, -0.06);
    set(j.neck, 0.04);
    // Guard up, weight slightly forward.
    set(j.arms.L.shoulder, -0.9, 0, 0.55);
    set(j.arms.L.elbow, -1.5);
    set(j.arms.R.shoulder, -0.9, 0, -0.55);
    set(j.arms.R.elbow, -1.5);
    set(j.legs.L.hip, -0.18, 0, 0.14);
    set(j.legs.L.knee, 0.3);
    set(j.legs.R.hip, 0.2, 0, -0.14);
    set(j.legs.R.knee, 0.32);
  },

  punch(j) {
    set(j.hips, 0, -0.35, 0);
    set(j.chest, -0.12, 0.5, 0);
    set(j.neck, 0.06, -0.15, 0);
    // Right arm fully extended, left pulled back as a counterweight.
    set(j.arms.R.shoulder, -1.62, 0, -0.1);
    set(j.arms.R.elbow, -0.06);
    set(j.arms.L.shoulder, -0.5, 0, 0.85);
    set(j.arms.L.elbow, -2.1);
    set(j.legs.L.hip, -0.5, 0, 0.16);
    set(j.legs.L.knee, 0.45);
    set(j.legs.R.hip, 0.45, 0, -0.16);
    set(j.legs.R.knee, 0.2);
  },

  grab(j) {
    set(j.hips, 0.1);
    set(j.chest, -0.2);
    set(j.neck, 0.1);
    // Both arms out front, hands apart — unmistakably reaching.
    set(j.arms.L.shoulder, -1.5, 0, 0.3);
    set(j.arms.L.elbow, -0.25);
    set(j.arms.R.shoulder, -1.5, 0, -0.3);
    set(j.arms.R.elbow, -0.25);
    set(j.legs.L.hip, -0.32, 0, 0.14);
    set(j.legs.L.knee, 0.5);
    set(j.legs.R.hip, 0.28, 0, -0.14);
    set(j.legs.R.knee, 0.5);
  },

  hit(j) {
    // Recoiling from a punch: head snapped back, arms thrown up.
    set(j.hips, -0.3, 0.2, 0.1);
    set(j.chest, 0.45, -0.2, 0);
    set(j.neck, 0.5, 0.1, 0.1);
    set(j.arms.L.shoulder, -2.5, 0, 0.9);
    set(j.arms.L.elbow, -0.5);
    set(j.arms.R.shoulder, -2.7, 0, -0.7);
    set(j.arms.R.elbow, -0.35);
    set(j.legs.L.hip, 0.55, 0, 0.25);
    set(j.legs.L.knee, 0.15);
    set(j.legs.R.hip, -0.3, 0, -0.3);
    set(j.legs.R.knee, 0.7);
  },

  ko(j) {
    // Flat on its back, limbs dumped. This is the shape a ragdoll settles into
    // and the reason the rig exists at all.
    set(j.hips, -1.5, 0.3, 0);
    set(j.chest, 0.25);
    set(j.neck, 0.35, 0.4, 0);
    set(j.arms.L.shoulder, -2.9, 0, 1.25);
    set(j.arms.L.elbow, -0.6);
    set(j.arms.R.shoulder, -2.6, 0, -1.4);
    set(j.arms.R.elbow, -0.9);
    set(j.legs.L.hip, -0.9, 0, 0.5);
    set(j.legs.L.knee, 1.1);
    set(j.legs.R.hip, -1.3, 0, -0.35);
    set(j.legs.R.knee, 0.7);
  },
};

/** Height the root should sit at for a given pose, so feet stay on the floor. */
export const POSE_LIFT = { stance: 0, punch: 0, grab: 0, hit: 0.08, ko: -0.52 };

export const SPECIES_LIST = [
  { id: 'pup', name: 'Pup', note: 'Floppy ears, big snout. Friendliest read.' },
  { id: 'kit', name: 'Kit', note: 'Sharp ears, browed. Reads as the quick one.' },
  { id: 'bun', name: 'Bun', note: 'Tall ears — the tallest silhouette.' },
  { id: 'cub', name: 'Cub', note: 'Round ears, heavy set. Looks like it hits hard.' },
  { id: 'quack', name: 'Quack', note: 'Hard flat beak. The only non-furry edge.' },
  { id: 'tusk', name: 'Tusk', note: 'Tusks and brows. The aggressive one.' },
];

export { CREAM, DARK, mat };
