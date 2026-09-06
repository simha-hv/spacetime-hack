import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

import { BASE_PATH, PORT, WS_PATH } from '@brawl/protocol';

import { attachRelay } from './relay.js';
import { RoomRegistry } from './rooms.js';
import { routeStatic, StaticFiles } from './static.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Build writes to dist/server/public/, alongside the bundled server itself.
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? path.resolve(here, 'public');

const port = Number(process.env.PORT ?? PORT);
const bindHost = process.env.BIND_HOST ?? '0.0.0.0'; // never localhost-only: phones need us
const quiet = process.env.QUIET === '1';

const log = (...args: unknown[]): void => {
  if (!quiet) console.log('[brawl]', ...args);
};

const rooms = new RoomRegistry();
const files = new StaticFiles(PUBLIC_DIR);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === `${BASE_PATH}/healthz`) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }),
    );
    return;
  }

  // Anything outside the base path is not ours. Redirect bare / for convenience
  // so hitting the box directly on :1099 lands on the host screen.
  if (!pathname.startsWith(BASE_PATH)) {
    if (pathname === '/') {
      res.writeHead(302, { Location: `${BASE_PATH}/` }).end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }

  const route = routeStatic(pathname);
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }

  void files.serve(req, res, route.name, route.cache).then((served) => {
    if (!served) {
      res
        .writeHead(500, { 'Content-Type': 'text/plain' })
        .end('build output missing — run `npm run build`');
    }
  });
});

// noServer + manual upgrade so we can reject non-/ws upgrade attempts cleanly.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== WS_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const stopRelay = attachRelay({
  wss,
  rooms,
  publicOrigin: process.env.PUBLIC_ORIGIN?.trim() || undefined,
  log,
});

/** Virtual interfaces a phone can never reach. Filter by name, not by IP
 *  range — this box's real NIC is 172.31.x, which overlaps docker's space. */
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|tun|tap|cni|flannel|kube)/i;

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      out.push(iface.address);
    }
  }
  return out;
}

server.listen(port, bindHost, () => {
  const publicOrigin = process.env.PUBLIC_ORIGIN?.trim();

  log(`listening on http://${bindHost}:${port}${BASE_PATH}/`);
  console.log('');
  console.log('  ┌─ brawl-games ────────────────────────────────────────────');
  console.log('  │');
  if (publicOrigin) {
    console.log(`  │  host screen   ${publicOrigin}${BASE_PATH}/`);
    console.log(`  │  phones join   ${publicOrigin}${BASE_PATH}/j/<CODE>`);
  } else {
    console.log(`  │  host screen   https://bsa-demo.dev.hyperverge.co${BASE_PATH}/`);
    console.log('  │                (via nginx -> localhost:1099)');
  }
  console.log('  │');
  for (const ip of lanAddresses()) {
    console.log(`  │  LAN direct    http://${ip}:${port}${BASE_PATH}/`);
  }
  console.log(`  │  local         http://localhost:${port}${BASE_PATH}/`);
  console.log('  │');
  console.log('  │  Open the host screen, then scan the QR with a phone.');
  console.log('  └──────────────────────────────────────────────────────────');
  console.log('');
});

const shutdown = (signal: string): void => {
  log(`${signal} — shutting down`);
  stopRelay();
  for (const client of wss.clients) client.close(1001, 'server_shutdown');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
