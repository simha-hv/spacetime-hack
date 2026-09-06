import * as THREE from 'three';

/**
 * The cast, as rigged 3D plush animals.
 *
 * Party Animals' own description of its look is "simple textures, plump
 * physiques, vivid colour schemes", and the silhouette is the whole trick:
 *
 *   - the head is ENORMOUS, wider than the body, roughly half the total height
 *   - the body is one small rounded bean, not a stack of segments
 *   - arms and legs are short, thick and splayed, so they read as separate
 *     shapes against the torso instead of merging into it
 *
 * That last point is not cosmetic. The first pass here built the torso from a
 * capsule with the arms hanging flat against it, and at gameplay distance the
 * overlapping silhouettes read as one ribbed tube — the characters looked like
 * caterpillars. Splaying the limbs out and shrinking the torso is what turns
 * the same geometry into a plush toy.
 *
 * Every animal is a HIERARCHY. A brawler needs limbs it can throw a punch with
 * and that can flail when it is knocked over:
 *
 *   root
 *    └ hips ── thighL/R ── shinL/R ── footL/R
 *       └ chest ── shoulderL/R ── forearmL/R ── handL/R
 *          └ head ── skull ── (ears, snout, horns — the species)
 *
 * Species differ only above the neck plus a tail, so a new animal is a few
 * lines rather than a new rig.
 */

export type SpeciesId = 'pup' | 'kit' | 'bun' | 'cub' | 'quack' | 'tusk';

export interface Species {
  id: SpeciesId;
  name: string;
  /** Scales body size and mass. */
  bulk: number;
}

export const SPECIES: readonly Species[] = [
  { id: 'pup', name: 'Pup', bulk: 1.0 },
  { id: 'kit', name: 'Kit', bulk: 0.94 },
  { id: 'bun', name: 'Bun', bulk: 0.95 },
  { id: 'cub', name: 'Cub', bulk: 1.12 },
  { id: 'quack', name: 'Quack', bulk: 0.98 },
  { id: 'tusk', name: 'Tusk', bulk: 1.08 },
];

const CREAM = '#fff3e2';
const DARK = '#2a2530';
const PINK = '#ffb0bb';

/** Geometry is shared across the whole cast — four players cost four materials. */
const G = {
  sphere: new THREE.SphereGeometry(1, 20, 15),
  capsule: new THREE.CapsuleGeometry(1, 1, 5, 14),
  cone: new THREE.ConeGeometry(1, 1, 12),
  box: new THREE.BoxGeometry(1, 1, 1),
};

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: string, rough = 0.96): THREE.MeshStandardMaterial {
  const key = `${color}|${rough}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: rough,
      metalness: 0,
    });
    matCache.set(key, m);
  }
  return m;
}

function part(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  p: [number, number, number],
  s: [number, number, number],
  r?: [number, number, number],
): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.position.set(p[0], p[1], p[2]);
  m.scale.set(s[0], s[1], s[2]);
  if (r) m.rotation.set(r[0], r[1], r[2]);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function joint(parent: THREE.Object3D, p: [number, number, number]): THREE.Group {
  const g = new THREE.Group();
  g.position.set(p[0], p[1], p[2]);
  parent.add(g);
  return g;
}

/* ----------------------------- proportions ------------------------------- */

/**
 * Toy proportions on purpose.
 *
 * Total height works out at about 1.75 world units with the head taking the
 * top 45% of it. Long limbs read as human and look wrong flailing; stubby ones
 * look funny and stay legible when the whole body is tumbling across a roof.
 */
const P = {
  hipY: 0.47,
  chestY: 0.3,
  headY: 0.5,
  /** Head sphere radius. Everything above the neck is expressed in units of it. */
  headR: 0.5,
  shoulderX: 0.36,
  shoulderY: 0.08,
  upperArm: 0.22,
  foreArm: 0.19,
  handR: 0.16,
  hipX: 0.18,
  thigh: 0.2,
  shin: 0.17,
};

/**
 * Eyes, identical on every species — they are what unifies the cast.
 * Coordinates are in unit-head space, so they scale with `headR`.
 */
function eyes(skull: THREE.Object3D, spread: number, y: number, z: number, brows = false): void {
  for (const s of [-1, 1]) {
    part(skull, G.sphere, mat(CREAM, 0.4), [s * spread, y, z], [0.26, 0.31, 0.18]);
    part(skull, G.sphere, mat(DARK, 0.25), [s * spread * 1.04, y, z + 0.12], [0.14, 0.17, 0.11]);
    if (brows) {
      part(skull, G.box, mat(DARK), [s * spread, y + 0.34, z + 0.04], [0.33, 0.08, 0.1], [0, 0, s * 0.4]);
    }
  }
}

type Decorate = (
  skull: THREE.Object3D,
  chest: THREE.Object3D,
  hips: THREE.Object3D,
  color: string,
) => void;

/**
 * Everything above the neck, in unit-head space: the skull is a sphere of
 * radius 1, so z = 0.7 sits on the front of the face whatever `headR` is.
 */
const SPECIES_PARTS: Record<SpeciesId, Decorate> = {
  pup(skull, _chest, hips, color) {
    part(skull, G.sphere, mat(CREAM), [0, -0.2, 0.72], [0.44, 0.33, 0.37]);
    part(skull, G.sphere, mat(DARK), [0, -0.07, 1.02], [0.17, 0.14, 0.14]);
    // Floppy ears, low and wide — the single most dog-like cue at distance.
    for (const s of [-1, 1]) {
      part(skull, G.capsule, mat(color), [s * 0.9, -0.34, -0.02], [0.27, 0.42, 0.17], [0, 0, s * 0.42]);
    }
    part(hips, G.capsule, mat(color), [0, 0.02, -0.28], [0.07, 0.11, 0.07], [1.0, 0, 0]);
    eyes(skull, 0.38, 0.22, 0.78);
  },

  kit(skull, _chest, hips, color) {
    for (const s of [-1, 1]) {
      part(skull, G.cone, mat(color), [s * 0.5, 1.0, 0], [0.38, 0.86, 0.3]);
      part(skull, G.cone, mat(PINK), [s * 0.5, 0.96, 0.11], [0.23, 0.6, 0.18]);
    }
    part(skull, G.sphere, mat(CREAM), [0, -0.18, 0.7], [0.32, 0.23, 0.3]);
    part(skull, G.sphere, mat(PINK), [0, -0.05, 0.94], [0.11, 0.09, 0.09]);
    part(hips, G.capsule, mat(color), [0, 0.1, -0.26], [0.06, 0.2, 0.06], [0.7, 0, 0]);
    eyes(skull, 0.4, 0.2, 0.76, true);
  },

  bun(skull, _chest, hips, color) {
    for (const s of [-1, 1]) {
      part(skull, G.capsule, mat(color), [s * 0.29, 1.28, -0.04], [0.18, 0.52, 0.12], [0, 0, s * 0.11]);
      part(skull, G.capsule, mat(PINK), [s * 0.29, 1.28, 0.04], [0.11, 0.39, 0.07], [0, 0, s * 0.11]);
    }
    part(skull, G.sphere, mat(CREAM), [0, -0.17, 0.72], [0.3, 0.23, 0.28]);
    part(skull, G.sphere, mat(PINK), [0, -0.04, 0.94], [0.1, 0.09, 0.08]);
    part(hips, G.sphere, mat(CREAM), [0, 0.02, -0.26], [0.1, 0.1, 0.075]);
    eyes(skull, 0.4, 0.2, 0.77);
  },

  cub(skull, _chest, _hips, color) {
    for (const s of [-1, 1]) part(skull, G.sphere, mat(color), [s * 0.72, 0.7, -0.07], [0.3, 0.3, 0.19]);
    part(skull, G.sphere, mat(CREAM), [0, -0.21, 0.74], [0.46, 0.35, 0.37]);
    part(skull, G.sphere, mat(DARK), [0, -0.07, 1.05], [0.18, 0.15, 0.14]);
    eyes(skull, 0.43, 0.23, 0.79, true);
  },

  quack(skull, chest, _hips, color) {
    part(skull, G.box, mat('#ffb638'), [0, -0.16, 0.78], [0.92, 0.2, 0.86]);
    part(skull, G.box, mat('#e89422'), [0, -0.32, 0.74], [0.76, 0.13, 0.74]);
    for (const s of [-1, 1]) {
      part(chest, G.capsule, mat(color), [s * 0.34, -0.04, -0.02], [0.06, 0.16, 0.12], [0, 0, s * 0.25]);
    }
    eyes(skull, 0.41, 0.28, 0.68);
  },

  tusk(skull, _chest, _hips, color) {
    part(skull, G.sphere, mat(CREAM), [0, -0.21, 0.78], [0.5, 0.37, 0.39]);
    for (const s of [-1, 1]) part(skull, G.sphere, mat(DARK), [s * 0.18, -0.12, 1.08], [0.11, 0.12, 0.09]);
    for (const s of [-1, 1]) {
      part(skull, G.cone, mat('#f5ead4'), [s * 0.39, -0.28, 0.84], [0.11, 0.36, 0.11], [-0.5, 0, s * 0.3]);
      part(skull, G.sphere, mat(color), [s * 0.76, 0.6, -0.05], [0.23, 0.25, 0.16]);
    }
    eyes(skull, 0.45, 0.25, 0.79, true);
  },
};

/* ------------------------------- the rig --------------------------------- */

export interface AnimalJoints {
  root: THREE.Group;
  hips: THREE.Group;
  chest: THREE.Group;
  head: THREE.Group;
  arms: Record<'L' | 'R', { shoulder: THREE.Group; elbow: THREE.Group }>;
  legs: Record<'L' | 'R', { hip: THREE.Group; knee: THREE.Group }>;
}

export interface Animal {
  root: THREE.Group;
  joints: AnimalJoints;
  setColor(hex: string): void;
  dispose(): void;
}

export function buildAnimal(speciesId: SpeciesId, color: string): Animal {
  // Per-instance material so recolouring one player never touches another.
  const skin = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.96,
    metalness: 0,
  });

  const root = new THREE.Group();

  // The torso is TWO overlapping spheres, not a capsule. Spheres blend into a
  // bean; a capsule reads as a segment, especially with limbs beside it.
  const hips = joint(root, [0, P.hipY, 0]);
  part(hips, G.sphere, skin, [0, 0, 0], [0.32, 0.26, 0.3]);

  const chest = joint(hips, [0, P.chestY, 0]);
  part(chest, G.sphere, skin, [0, -0.06, 0], [0.35, 0.3, 0.33]);
  // Belly patch. Two-tone is most of what separates "toy" from "blob".
  part(chest, G.sphere, mat(CREAM), [0, -0.1, 0.2], [0.21, 0.2, 0.2]);

  const head = joint(chest, [0, P.headY, 0]);
  // Everything above the neck lives in unit-head space inside this group, so
  // changing headR rescales the whole face consistently.
  const skull = new THREE.Group();
  skull.scale.setScalar(P.headR);
  head.add(skull);
  part(skull, G.sphere, skin, [0, 0, 0], [1, 0.95, 0.95]);

  const joints: AnimalJoints = {
    root,
    hips,
    chest,
    head,
    arms: {} as AnimalJoints['arms'],
    legs: {} as AnimalJoints['legs'],
  };

  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? -1 : 1;

    const shoulder = joint(chest, [s * P.shoulderX, P.shoulderY, 0]);
    part(shoulder, G.capsule, skin, [0, -P.upperArm / 2, 0], [0.135, P.upperArm / 2, 0.135]);
    const elbow = joint(shoulder, [0, -P.upperArm, 0]);
    part(elbow, G.capsule, skin, [0, -P.foreArm / 2, 0], [0.125, P.foreArm / 2, 0.125]);
    // Mitten hands: one round shape, no fingers. Reads as a fist at distance.
    part(elbow, G.sphere, skin, [0, -P.foreArm, 0], [P.handR, P.handR, P.handR]);
    joints.arms[side] = { shoulder, elbow };

    const hip = joint(hips, [s * P.hipX, -0.08, 0]);
    part(hip, G.capsule, skin, [0, -P.thigh / 2, 0], [0.145, P.thigh / 2, 0.145]);
    const knee = joint(hip, [0, -P.thigh, 0]);
    part(knee, G.capsule, skin, [0, -P.shin / 2, 0], [0.135, P.shin / 2, 0.135]);
    part(knee, G.sphere, skin, [0, -P.shin, 0.07], [0.185, 0.12, 0.25]);
    joints.legs[side] = { hip, knee };
  }

  SPECIES_PARTS[speciesId](skull, chest, hips, color);

  return {
    root,
    joints,
    setColor: (hex) => skin.color.set(hex),
    dispose: () => skin.dispose(),
  };
}

/* --------------------------------- poses --------------------------------- */

function set(j: THREE.Object3D, x: number, y = 0, z = 0): void {
  j.rotation.set(x, y, z);
}

/**
 * Poses blended by the fighter each frame.
 *
 * These are targets, not animations — the fighter lerps toward whichever one
 * its state calls for, so the transitions come free and a body that is being
 * physically flung still reads as reaching or flailing.
 *
 * Note how far the arms are splayed even at idle (the z component on every
 * shoulder). Arms hanging straight down disappear into the torso silhouette,
 * which is exactly how a plush animal turns into a caterpillar.
 */
export const POSES = {
  idle(j: AnimalJoints): void {
    set(j.chest, -0.04);
    set(j.head, 0.04);
    set(j.arms.L.shoulder, -0.2, 0, 0.72);
    set(j.arms.L.elbow, -0.3, 0, 0.16);
    set(j.arms.R.shoulder, -0.2, 0, -0.72);
    set(j.arms.R.elbow, -0.3, 0, -0.16);
    set(j.legs.L.hip, 0, 0, 0.1);
    set(j.legs.L.knee, 0.08);
    set(j.legs.R.hip, 0, 0, -0.1);
    set(j.legs.R.knee, 0.08);
  },

  run(j: AnimalJoints, t: number): void {
    const s = Math.sin(t * 11);
    const c = Math.cos(t * 11);
    set(j.chest, -0.14);
    set(j.head, 0.1);
    set(j.arms.L.shoulder, -0.45 + s * 0.8, 0, 0.6);
    set(j.arms.L.elbow, -0.75, 0, 0.14);
    set(j.arms.R.shoulder, -0.45 - s * 0.8, 0, -0.6);
    set(j.arms.R.elbow, -0.75, 0, -0.14);
    set(j.legs.L.hip, s * 0.75, 0, 0.1);
    set(j.legs.L.knee, Math.max(0, -c) * 0.95);
    set(j.legs.R.hip, -s * 0.75, 0, -0.1);
    set(j.legs.R.knee, Math.max(0, c) * 0.95);
  },

  /**
   * The cock, held for the windup.
   *
   * A punch that goes straight to full extension has no readable anticipation
   * and looks like a twitch — from across a room you cannot tell it happened.
   * Winding the body the OPPOSITE way first is what makes the snap register,
   * and it is the oldest trick in animation for a reason.
   */
  windup(j: AnimalJoints): void {
    set(j.chest, 0.06, -0.5, 0);
    set(j.head, -0.06, 0.25, 0);
    // Right fist drawn back past the shoulder, elbow folded tight.
    set(j.arms.R.shoulder, 0.55, 0, -0.5);
    set(j.arms.R.elbow, -2.3, 0, -0.2);
    set(j.arms.L.shoulder, -0.9, 0, 0.55);
    set(j.arms.L.elbow, -0.7, 0, 0.1);
    set(j.legs.L.hip, 0.2, 0, 0.16);
    set(j.legs.L.knee, 0.3);
    set(j.legs.R.hip, -0.15, 0, -0.16);
    set(j.legs.R.knee, 0.35);
  },

  punch(j: AnimalJoints): void {
    set(j.chest, -0.14, 0.62, 0);
    set(j.head, 0.08, -0.24, 0);
    // Right arm fully extended and slightly across, left flung back as a
    // counterweight — the whole body sells the swing, not just the arm.
    set(j.arms.R.shoulder, -1.85, 0, -0.06);
    set(j.arms.R.elbow, 0.05);
    set(j.arms.L.shoulder, 0.35, 0, 1.25);
    set(j.arms.L.elbow, -1.5, 0, 0.25);
    set(j.legs.L.hip, -0.55, 0, 0.16);
    set(j.legs.L.knee, 0.5);
    set(j.legs.R.hip, 0.45, 0, -0.16);
    set(j.legs.R.knee, 0.25);
  },

  reach(j: AnimalJoints): void {
    set(j.chest, -0.18);
    set(j.head, 0.1);
    set(j.arms.L.shoulder, -1.5, 0, 0.34);
    set(j.arms.L.elbow, -0.18);
    set(j.arms.R.shoulder, -1.5, 0, -0.34);
    set(j.arms.R.elbow, -0.18);
    set(j.legs.L.hip, -0.2, 0, 0.12);
    set(j.legs.L.knee, 0.35);
    set(j.legs.R.hip, 0.18, 0, -0.12);
    set(j.legs.R.knee, 0.35);
  },

  flail(j: AnimalJoints, t: number): void {
    const s = Math.sin(t * 22);
    const c = Math.cos(t * 19);
    set(j.chest, 0.28 + s * 0.2);
    set(j.head, 0.4 + c * 0.2, s * 0.3, 0);
    set(j.arms.L.shoulder, -2.4 + s * 0.7, 0, 1.15);
    set(j.arms.L.elbow, -0.4 + c * 0.5);
    set(j.arms.R.shoulder, -2.4 - s * 0.7, 0, -1.15);
    set(j.arms.R.elbow, -0.4 - c * 0.5);
    set(j.legs.L.hip, 0.5 + c * 0.5, 0, 0.34);
    set(j.legs.L.knee, 0.3);
    set(j.legs.R.hip, 0.4 - c * 0.5, 0, -0.34);
    set(j.legs.R.knee, 0.6);
  },
} as const;

/** Blend every joint toward a target pose. `k` is 0..1 per frame. */
export function blendPose(j: AnimalJoints, apply: (j: AnimalJoints) => void, k: number): void {
  // Read the current rotations, let `apply` overwrite them with the target,
  // then interpolate back. Cheaper than maintaining a parallel target rig.
  const nodes = [
    j.chest,
    j.head,
    j.arms.L.shoulder,
    j.arms.L.elbow,
    j.arms.R.shoulder,
    j.arms.R.elbow,
    j.legs.L.hip,
    j.legs.L.knee,
    j.legs.R.hip,
    j.legs.R.knee,
  ];
  const prev = nodes.map((n) => [n.rotation.x, n.rotation.y, n.rotation.z] as const);
  apply(j);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const p = prev[i]!;
    n.rotation.set(
      p[0] + (n.rotation.x - p[0]) * k,
      p[1] + (n.rotation.y - p[1]) * k,
      p[2] + (n.rotation.z - p[2]) * k,
    );
  }
}
