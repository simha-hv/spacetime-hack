import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const publicDir = path.join(dist, 'server', 'public');

const dev = process.argv.includes('--dev');

/** Controller budget. The page loads over congested venue wifi, ten at once. */
const CONTROLLER_BUDGET_BYTES = 100 * 1024;

const shared = {
  bundle: true,
  format: 'esm',
  target: ['es2020', 'safari14'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  tsconfig: path.join(root, 'tsconfig.json'),
  logLevel: 'warning',
};

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

async function buildServer() {
  await build({
    ...shared,
    entryPoints: [path.join(root, 'packages/server/src/index.ts')],
    outfile: path.join(dist, 'server/index.js'),
    platform: 'node',
    target: 'node20',
    minify: false, // server size is irrelevant; readable stack traces are not
    packages: 'external',
    banner: {
      js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
    },
  });
}

/**
 * The host ships as ESM with code splitting, NOT a single IIFE.
 *
 * That is the whole point: Three plus Rapier is ~1.2MB gzipped and an IIFE
 * cannot split, so a dynamic import() would be silently inlined and the QR
 * screen would wait on the entire 3D engine before painting. With splitting,
 * the entry chunk is a few KB, the QR is on screen immediately, and the engine
 * streams in while people are still scanning.
 */
async function buildHost() {
  const result = await build({
    ...shared,
    entryPoints: [path.join(root, 'packages/host/src/main.ts')],
    outdir: publicDir,
    // The entry filename carries a content hash, and the HTML that points at
    // it is no-store. Without this the entry has a stable name, so a browser
    // that ever cached it under a long max-age keeps running that build
    // forever — a deploy simply never reaches the screen, and the symptom
    // (fresh HTML, stale behaviour, no obvious error) is baffling to diagnose.
    entryNames: 'host-[hash]',
    chunkNames: 'chunk-[hash]',
    platform: 'browser',
    format: 'esm',
    splitting: true,
    metafile: true,
  });

  const outputs = result.metafile.outputs;
  const entryPath = Object.keys(outputs).find((name) => /\/host-[A-Z0-9]+\.js$/i.test(name));
  if (!entryPath) throw new Error('could not find the built host entry');
  const entryFile = path.basename(entryPath);

  const shell = await readFile(path.join(root, 'packages/host/index.html'), 'utf8');
  if (!shell.includes('__HOST_ENTRY__')) {
    throw new Error('host/index.html is missing the __HOST_ENTRY__ placeholder');
  }
  await writeFile(path.join(publicDir, 'host.html'), shell.replace('__HOST_ENTRY__', () => entryFile));

  const total = Object.values(outputs).reduce((sum, o) => sum + o.bytes, 0);
  return {
    entry: outputs[entryPath].bytes,
    entryFile,
    total,
    chunks: Object.keys(outputs).length,
  };
}

/**
 * The controller ships as ONE self-contained HTML file: no external CSS, no
 * external JS, no fonts, no favicon request. One round trip, one document,
 * gzipped at build time. That is the difference between joining in three
 * seconds and watching a spinner while nine other phones fight for the AP.
 */
async function buildController() {
  const result = await build({
    ...shared,
    entryPoints: [path.join(root, 'packages/controller/src/main.ts')],
    outfile: path.join(dist, '.tmp/controller.js'),
    platform: 'browser',
    format: 'iife',
    write: false,
  });

  const js = result.outputFiles[0].text;
  const shell = await readFile(path.join(root, 'packages/controller/index.html'), 'utf8');

  if (!shell.includes('/*__CONTROLLER_BUNDLE__*/')) {
    throw new Error('controller/index.html is missing the bundle placeholder');
  }
  // `$` is special in String.replace patterns; use a function to paste literally.
  const html = shell.replace('/*__CONTROLLER_BUNDLE__*/', () => js);

  await writeFile(path.join(publicDir, 'controller.html'), html);
  return Buffer.byteLength(html);
}

/**
 * The protocol, bundled as plain ESM so the test files can import it without
 * a TypeScript runtime. Tests exercise the same code the wire uses.
 */
async function buildProtocolForTests() {
  await build({
    ...shared,
    entryPoints: [
      path.join(root, 'packages/protocol/src/index.ts'),
      // The host's input pipeline — latest-wins, stale rejection, press
      // diffing — is protocol-critical, so it gets tested like protocol code.
      path.join(root, 'packages/host/src/input-state.ts'),
    ],
    outdir: path.join(dist, 'test'),
    // Flat output: without this esbuild mirrors the common source tree and
    // emits dist/test/protocol/src/index.js.
    entryNames: '[name]',
    platform: 'neutral',
    format: 'esm',
    minify: false,
  });
}

/**
 * The visual prototypes: copied verbatim, plus a vendored three.module.js they
 * all share.
 *
 * Deliberately NOT bundled. They are hand-written standalone pages so the look
 * can be iterated on directly, and keeping them out of the build pipeline means
 * a prototype can never break the real game's build.
 */
async function copyPrototypes() {
  const src = path.join(root, 'packages/prototypes');
  const dest = path.join(publicDir, 'proto');
  await mkdir(dest, { recursive: true });

  // Recursive: the prototypes now carry a models/ folder of .glb files.
  const copyTree = async (from, to) => {
    await mkdir(to, { recursive: true });
    for (const e of await readdir(from, { withFileTypes: true })) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) await copyTree(a, b);
      else await copyFile(a, b);
    }
  };
  await copyTree(src, dest);
  // Vendored engine builds the prototypes import directly. three.module.js
  // re-exports from three.core.js — copying only the first gives a 404 on the
  // second and a silently blank page.
  const vendored = [
    ['three/build/three.module.js', 'three.module.js'],
    ['three/build/three.core.js', 'three.core.js'],
    ['pixi.js/dist/pixi.min.mjs', 'pixi.min.mjs'],
    ['roughjs/bundled/rough.esm.js', 'rough.esm.js'],
    // GLTFLoader imports 'three' (bare) and a sibling util by relative path,
    // so it needs its directory shape preserved plus an import map in the page.
    ['three/examples/jsm/loaders/GLTFLoader.js', 'jsm/loaders/GLTFLoader.js'],
    ['three/examples/jsm/utils/BufferGeometryUtils.js', 'jsm/utils/BufferGeometryUtils.js'],
    ['three/examples/jsm/utils/SkeletonUtils.js', 'jsm/utils/SkeletonUtils.js'],
  ];
  for (const [from, to] of vendored) {
    const target = path.join(dest, to);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, 'node_modules', from), target);
  }

  // cast.html renders the REAL cast, not a copy of it. Compiling the game's own
  // animal.ts into the prototypes folder is what keeps the two from drifting —
  // a character review page that shows last week's proportions is worse than no
  // review page. `three` stays external so the page's import map supplies the
  // same vendored build every other prototype uses.
  for (const [from, to] of [
    ['packages/host/src/game/animal.ts', 'cast-animal.js'],
    ['packages/host/src/game/effects.ts', 'cast-effects.js'],
  ]) {
    await build({
      ...shared,
      entryPoints: [path.join(root, from)],
      outfile: path.join(dest, to),
      format: 'esm',
      external: ['three'],
      minify: false,
    });
  }
}

/**
 * The game layer, bundled for node so the physics tests drive the REAL fighter
 * on the REAL level — same gravity, gains and impulses the big screen runs.
 *
 * three and Rapier are bundled in rather than left external: three's math and
 * scene graph need no DOM, and rapier3d-compat carries its WASM inline, so the
 * whole thing loads under plain node with no browser shims.
 */
async function buildGameForTests() {
  await build({
    ...shared,
    entryPoints: [path.join(root, 'packages/host/src/game/index.ts')],
    outfile: path.join(dist, 'test/game.js'),
    platform: 'node',
    target: 'node20',
    format: 'esm',
    minify: false,
  });
}

/** Precompress so the server never gzips on a request. */
async function precompress(names) {
  const out = {};
  for (const name of names) {
    const file = path.join(publicDir, name);
    const body = await readFile(file);
    const gz = gzipSync(body, { level: 9 });
    await writeFile(`${file}.gz`, gz);
    out[name] = { raw: body.byteLength, gz: gz.byteLength };
  }
  return out;
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(publicDir, { recursive: true });

  const [, hostJs] = await Promise.all([
    buildServer(),
    buildHost(),
    buildController(),
    buildProtocolForTests(),
  ]);

  // Sequential: shares dist/test with the protocol bundle, and two esbuild
  // runs creating the same directory at once race on rmdir.
  await buildGameForTests();
  await copyPrototypes();

  // Every emitted file, so split chunks are compressed too.
  const emitted = (await readdir(publicDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && !e.name.endsWith('.gz'))
    .map((e) => e.name);
  const sizes = await precompress(emitted);
  await rm(path.join(dist, '.tmp'), { recursive: true, force: true });

  const controller = sizes['controller.html'];
  const lazy = hostJs.total - hostJs.entry;
  const lazyGz = Object.entries(sizes)
    .filter(([name]) => name.startsWith('chunk-'))
    .reduce((sum, [, v]) => sum + v.gz, 0);
  console.log('');
  console.log(`  build complete${dev ? ' (dev: unminified + inline sourcemaps)' : ''}`);
  console.log(
    `    host entry       ${kb(hostJs.entry).padStart(8)}  (gzip ${kb(sizes[hostJs.entryFile].gz)})  paints the QR`,
  );
  console.log(
    `    host lazy        ${kb(lazy).padStart(8)}  (gzip ${kb(lazyGz)})  game, ${hostJs.chunks - 1} chunks, loaded after`,
  );
  console.log(
    `    controller.html  ${kb(controller.raw).padStart(8)}  (gzip ${kb(controller.gz)})` +
      (dev ? '' : `  ${((controller.raw / CONTROLLER_BUDGET_BYTES) * 100).toFixed(0)}% of 100KB budget`),
  );

  // The budget is a property of what ships, so it is only enforced on a
  // production build. A dev bundle carries sourcemaps and is expected to be
  // several times larger — failing on that would just block `npm run dev`.
  if (!dev && controller.raw > CONTROLLER_BUDGET_BYTES) {
    console.error(
      `\n  ERROR: controller is ${kb(controller.raw)}, over the ${kb(CONTROLLER_BUDGET_BYTES)} budget.`,
    );
    process.exit(1);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
