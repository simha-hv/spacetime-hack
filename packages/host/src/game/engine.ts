import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

/**
 * Renderer + physics world bootstrap.
 *
 * Deliberately modest: one directional light with a single shadow map, one
 * hemisphere fill, no post-processing, no environment map. The look comes
 * from flat matte materials and a warm/cool light pair, which costs nothing
 * per frame, rather than from effects — this has to hold 60fps on whatever
 * machine is plugged into the TV.
 */

export interface Engine {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  rapier: typeof RAPIER;
  world: RAPIER.World;
  eventQueue: RAPIER.EventQueue;
  resize(): void;
  dispose(): void;
}

/** Physics runs at a fixed 60Hz regardless of display rate. */
export const STEP_MS = 1000 / 60;

let rapierReady: Promise<typeof RAPIER> | null = null;

/** The WASM init is idempotent but not cheap; share one attempt. */
export function loadRapier(): Promise<typeof RAPIER> {
  rapierReady ??= RAPIER.init().then(() => RAPIER);
  return rapierReady;
}

export async function createEngine(canvas: HTMLCanvasElement): Promise<Engine> {
  const rapier = await loadRapier();

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  // Capped at 2: beyond that the pixel count triples for no visible gain on a
  // screen people are sitting three metres from.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  // PCFSoft is roughly twice the cost for softness nobody notices on shapes
  // this chunky.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1b2440');
  scene.fog = new THREE.Fog('#1b2440', 34, 62);

  const camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.5, 140);

  // Key light: warm, angled, and the only shadow caster.
  const key = new THREE.DirectionalLight('#fff0d8', 2.5);
  key.position.set(9, 16, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0012;
  // The shadow camera is sized to the arena, not the world. Too wide and the
  // 1024 map spreads thin and the contact shadows under feet dissolve, which
  // is the one shadow that actually matters for reading depth.
  const s = key.shadow.camera;
  s.left = -16;
  s.right = 16;
  s.top = 14;
  s.bottom = -14;
  s.near = 1;
  s.far = 48;
  s.updateProjectionMatrix();
  scene.add(key);
  scene.add(key.target);

  // Cool sky / warm bounce. Does most of the work of making the plush
  // materials look soft instead of plastic.
  scene.add(new THREE.HemisphereLight('#9fc4ff', '#4a3f52', 1.35));

  const world = new rapier.World({ x: 0, y: -22.5, z: 0 });
  // Gravity is well above real: earth gravity on a 2m character makes every
  // jump and every fall feel floaty. Heavier gravity plus bigger impulses is
  // the standard platformer trade and it reads as snappy, not heavy.

  const eventQueue = new rapier.EventQueue(true);

  const resize = (): void => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // updateStyle left ON. A <canvas> is a replaced element, so without a CSS
    // size it lays out at its intrinsic attribute size — at dpr 2 that is
    // twice the viewport and you see only the top-left quarter of the game.
    renderer.setSize(w, h);
  };
  resize();

  return {
    renderer,
    scene,
    camera,
    rapier,
    world,
    eventQueue,
    resize,
    dispose(): void {
      eventQueue.free();
      world.free();
      renderer.dispose();
    },
  };
}
