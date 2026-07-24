// Stream-Share signaling server: in-memory room registry + blind relay
// of WebRTC messages (SDP/ICE). No media transits here. See docs/signaling-server.md.
//
// Run:  node src/index.js   (then open http://localhost:8080/test.html in 2 tabs)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { newCode, format, normalize, isBanned } from './rooms.js';

const PORT = Number(process.env.PORT) || 8080;
// Grace period given to the host to reconnect (reclaim) before the room is destroyed.
const DEFAULT_GRACE_MS = Number(process.env.GRACE_MS) || 30_000;
const ICE_SERVERS = (process.env.ICE_SERVERS || 'stun:stun.l.google.com:19302')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean)
  .map((urls) => ({ urls }));
// Behind Traefik only (see docker-compose.yml). When listening directly, leave at 0:
// X-Forwarded-For is then entirely controlled by the client.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const MAX_VIEWERS = Number(process.env.MAX_VIEWERS) || 10;
const MAX_PAYLOAD = 64 * 1024; // SDP/ICE fit in a few KB
const MSG_MAX_PER_SEC = 60; // beyond this, the connection is closed
const HEARTBEAT_MS = 30_000; // ping every 30 s; a socket with no pong by the next round is dead

const here = dirname(fileURLToPath(import.meta.url));
const OPEN = 1; // WebSocket.OPEN

/** @typedef {{ code: string, hostId: string, hostToken: string, viewers: Map<string, {id:string,pseudo:string}>, bannedIps: Set<string>, bannedTokens: Set<string>, createdAt: number, graceTimer: NodeJS.Timeout | null }} Room */
const rooms = new Map(); // code canonique -> Room
const clients = new Map(); // peerId -> { id, ws, ip, token, roomCode, role }

let seq = 0;
const genId = () => `p${++seq}`;

// Per-IP rate limit: in-memory sliding window (ponytail: no lib, no Redis).
// `join` is throttled to make code scanning impractical (32⁶ codes / 30 attempts
// per minute per IP). IPs come from `clientIp`, so they are real behind the proxy.
const RATE = {
  create: { log: new Map(), max: 10, window: 60_000 },
  join: { log: new Map(), max: 30, window: 60_000 },
};
// Cumulative counters since startup, exposed by /health. The rejections are what tell whether
// we're under attack — `rooms`/`viewers` only tell whether the service is serving. Deliberately
// flat integers: no time series here, that's the job of whatever scrapes it.
const rejected = { createRateLimited: 0, joinRateLimited: 0, originRejected: 0, floodClosed: 0, banned: 0, handlerError: 0 };

function allow(kind, ip, now) {
  const { log, max, window } = RATE[kind];
  const hits = (log.get(ip) || []).filter((t) => now - t < window);
  log.set(ip, hits);
  if (hits.length >= max) return false;
  hits.push(now);
  return true;
}

// Test-only: the room/client maps and rate-limit logs are module-global, so test files sharing
// this module inherit each other's state (used codes, consumed create/join budget). A file can
// bracket itself with this to stay isolated — never called in production.
export function _resetState() {
  rooms.clear();
  clients.clear();
  RATE.create.log.clear();
  RATE.join.log.clear();
  for (const k of Object.keys(rejected)) rejected[k] = 0;
  seq = 0;
}

// Without this, a key for an IP never seen again lives forever (timestamps are filtered on
// read, but the read no longer happens). Swept at the frequency of the window.
setInterval(() => {
  const now = Date.now();
  for (const { log, window } of Object.values(RATE)) {
    for (const [ip, hits] of log) if (hits.every((t) => now - t >= window)) log.delete(ip);
  }
}, 60_000).unref();

/** Real client IP. Behind the proxy, the *last* hop of X-Forwarded-For is the one
 *  added by Traefik (the socket address it sees); the earlier entries come from the
 *  client and are therefore spoofable. Without TRUST_PROXY, the header is never read. */
export function clientIp(req, trustProxy = TRUST_PROXY) {
  if (trustProxy) {
    const last = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .pop()
      .trim();
    if (last) return last;
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Anti-CSWSH. Origin absent = non-browser client (tests, CLI): nothing to spoof, let it
 *  through — the CSWSH vector only exists in a browser, which always sends the header.
 *  Empty allow-list = not configured (dev): no check. */
export function originAllowed(origin, list = ALLOWED_ORIGINS) {
  if (!list.length || !origin) return true;
  return list.includes(origin);
}

function send(ws, type, payload = {}) {
  if (ws.readyState === OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

function onCreate(client) {
  // A socket holds only one room. Without this guard, a second `create` overwrites `client.roomCode`
  // and the previous room becomes orphaned: `cleanup` only collects the last one, the others
  // live on without a host until OOM and their code leaves the pool. The front never opens two
  // rooms on the same socket (app.ts).
  if (client.roomCode) return send(client.ws, 'error', { reason: 'already-in-room' });
  const now = Date.now();
  if (!allow('create', client.ip, now)) {
    rejected.createRateLimited++;
    return send(client.ws, 'error', { reason: 'rate-limited' });
  }
  const code = newCode(rooms);
  const hostToken = randomUUID(); // secret to take back control (reclaim) after a disconnect
  rooms.set(code, { code, hostId: client.id, hostToken, viewers: new Map(), bannedIps: new Set(), bannedTokens: new Set(), createdAt: now, graceTimer: null });
  client.roomCode = code;
  client.role = 'host';
  send(client.ws, 'created', { code, display: format(code), hostToken, iceServers: ICE_SERVERS });
}

// The host takes back its room after a disconnect, within the grace window, via its hostToken.
function onReclaim(client, { code, hostToken }) {
  const room = rooms.get(normalize(code));
  // Reclaimable only if the room exists, is in grace (host absent) and the token matches.
  if (!room || !room.graceTimer || room.hostToken !== hostToken) {
    return send(client.ws, 'reclaim-error', { reason: 'invalid' });
  }
  clearTimeout(room.graceTimer);
  room.graceTimer = null;
  // peerId continuity: the host takes back its old id so that the `signal {to: hostId}`
  // sent by viewers keep routing to it.
  clients.delete(client.id);
  client.id = room.hostId;
  client.roomCode = room.code;
  client.role = 'host';
  clients.set(client.id, client);
  const viewers = [...room.viewers.values()].map((v) => ({ peerId: v.id, pseudo: v.pseudo }));
  send(client.ws, 'reclaimed', { viewers, iceServers: ICE_SERVERS });
}

function destroyRoom(room) {
  for (const vId of room.viewers.keys()) {
    const v = clients.get(vId);
    if (v) send(v.ws, 'peer-left', { peerId: room.hostId, reason: 'host-left' });
  }
  rooms.delete(room.code);
}

function onJoin(client, { code, pseudo, token }) {
  // Counted before any check: a scanner must not get free attempts
  // on non-existent codes — those are precisely the ones it sends en masse.
  if (!allow('join', client.ip, Date.now())) {
    rejected.joinRateLimited++;
    return send(client.ws, 'join-error', { reason: 'rate-limited' });
  }
  const room = rooms.get(normalize(code));
  if (!room) return send(client.ws, 'join-error', { reason: 'not-found' });
  if (isBanned(room, client.ip, token)) {
    // Counted HERE (join refused because of ban), not when the ban is issued: `rejected` measures the abuse suffered,
    // and a banned user who retries IS abuse. A ban issued by the host is a deliberate action.
    rejected.banned++;
    return send(client.ws, 'join-error', { reason: 'banned' });
  }
  // The mesh (one stream encoded per viewer on the host side) doesn't hold beyond a handful:
  // the cap protects the host's browser as much as the server's memory.
  if (room.viewers.size >= MAX_VIEWERS) return send(client.ws, 'join-error', { reason: 'full' });
  client.roomCode = room.code;
  client.role = 'viewer';
  client.token = token || '';
  // `String()`: `pseudo` comes from JSON.parse, so from any type — a number threw
  // on `.slice`. The cap at 20 is the only bound on the server side, the front sets none.
  const name = String(pseudo ?? 'viewer').slice(0, 20);
  room.viewers.set(client.id, { id: client.id, pseudo: name });
  send(client.ws, 'joined', { hostId: room.hostId, iceServers: ICE_SERVERS });
  const host = clients.get(room.hostId);
  if (host) send(host.ws, 'peer-joined', { peerId: client.id, pseudo: name });
}

// Blind relay: the server does not read `data`, it copies it to the target peer in the same room.
function onSignal(client, { to, data }) {
  // Without this guard, two clients outside any room (roomCode null on both sides → null === null) could
  // relay to each other. Defense-in-depth: a client must be in a room to relay.
  if (!client.roomCode) return;
  const target = clients.get(to);
  if (!target || target.roomCode !== client.roomCode) return;
  send(target.ws, 'signal', { from: client.id, data });
}

function onKickBan(client, { peerId }, ban) {
  const room = rooms.get(client.roomCode);
  if (!room || room.hostId !== client.id) return; // host only
  const viewer = clients.get(peerId);
  if (!viewer || viewer.roomCode !== room.code) return;
  if (ban) {
    room.bannedIps.add(viewer.ip); // rejected.banned is counted at the refused join, not here (host action)
    if (viewer.token) room.bannedTokens.add(viewer.token);
  }
  room.viewers.delete(peerId);
  viewer.roomCode = null;
  send(viewer.ws, 'kicked', { banned: ban });
  try {
    viewer.ws.close();
  } catch {}
}

function cleanup(client, grace) {
  // If the map no longer references THIS object under this id (host reclaimed under the same id, or
  // a second cleanup via close+error), touch nothing: otherwise we'd delete the reclaimed one.
  if (clients.get(client.id) !== client) return;
  clients.delete(client.id);
  const room = rooms.get(client.roomCode);
  client.roomCode = null;
  if (!room) return;
  if (client.role === 'host' && room.hostId === client.id) {
    // Grace period: keep the room alive to let the host reconnect (reclaim).
    // Viewers are not notified until the grace has expired.
    room.graceTimer = setTimeout(() => destroyRoom(room), grace);
    room.graceTimer.unref(); // don't keep the process alive just for this timer
  } else {
    room.viewers.delete(client.id);
    const host = clients.get(room.hostId);
    if (host) send(host.ws, 'peer-left', { peerId: client.id });
  }
}

// Explicit departure (the user clicked Stop/Leave): deliberate, so we finish right
// away — unlike an unexpected socket drop, which opens a grace
// window for the host to reclaim.
function onLeave(client, grace) {
  const room = rooms.get(client.roomCode);
  if (room && client.role === 'host' && room.hostId === client.id) {
    if (room.graceTimer) clearTimeout(room.graceTimer);
    destroyRoom(room); // notifies the viewers (peer-left host-left) + frees the code, no grace
  }
  cleanup(client, grace); // removes the client; for a viewer, also notifies the host
}

export function createSignalingServer(opts = {}) {
  // Local to the closure, no longer a module-level `let` shared across servers: two createSignalingServer
  // in the same process no longer clash (the last one used to win retroactively for all of them).
  const grace = opts.graceMs ?? DEFAULT_GRACE_MS;
  const server = createServer((req, res) => {
    // Deliberately NOT routed by Traefik (which only sends Host + PathPrefix(/ws) here): reachable
    // only from the Docker network and the compose healthcheck. This is what lets us expose
    // the counters without a second thought — publishing them would give an attacker direct feedback on
    // the effect of their attempts. Don't add a `/health` router without revisiting this choice.
    if (req.method === 'GET' && req.url === '/health') {
      let viewers = 0;
      for (const room of rooms.values()) viewers += room.viewers.size;
      res.writeHead(200, { 'content-type': 'application/json' });
      // `connections` counts all open sockets, including those that have neither
      // created nor joined yet: a lasting gap with rooms+viewers signals clients hanging around.
      return res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, viewers, connections: clients.size, rejected }));
    }
    // Dev test page only. `public/` is already excluded from the prod image (.dockerignore), so
    // this path answers 404 there anyway; the gate makes the intent explicit and costs one line.
    if (req.method === 'GET' && process.env.NODE_ENV !== 'production' && (req.url === '/' || req.url === '/test.html')) {
      try {
        const html = readFileSync(join(here, '..', 'public', 'test.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch {
        res.writeHead(404);
        return res.end('test.html not found');
      }
    }
    res.writeHead(404);
    res.end('not found');
  });

  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_PAYLOAD,
    verifyClient: ({ origin }) => {
      const ok = originAllowed(origin);
      if (!ok) rejected.originRejected++;
      return ok;
    },
  });

  // Heartbeat. A socket dropped at the TCP level (a mobile losing signal — the central case here)
  // fires neither 'close' nor 'error' until the OS keepalive kicks in (~2 h). Until then cleanup()
  // never runs: the viewer keeps a slot and a ghost row on the host, and for a departed host the
  // grace window never even starts. Ping every round; terminate whatever missed the previous pong.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate(); // fires 'close' → cleanup(client) → frees the slot / starts host grace
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref(); // don't keep the process alive just for the heartbeat (like the rate-limit sweep)
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true)); // the client answers our ping automatically
    const ip = clientIp(req);
    const client = { id: genId(), ws, ip, token: '', roomCode: null, role: null };
    clients.set(client.id, client);
    send(ws, 'hello', { peerId: client.id });

    // Per-connection throttle: fixed one-second window. Beyond the threshold we close instead
    // of dropping the message — a `signal` lost silently would break the ICE negotiation, whereas
    // a close is a visible failure the client knows how to handle (reconnection).
    let windowStart = 0;
    let msgCount = 0;

    ws.on('message', (raw) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        msgCount = 0;
      }
      if (++msgCount > MSG_MAX_PER_SEC) {
        // `close()` does not flush what is already buffered: the handler keeps firing for
        // each remaining message. Relying on readyState counts ONE close per connection (and
        // avoids re-closing) — otherwise a single flooder inflates the counter by the number of messages
        // it managed to queue up, and /health makes it look like hundreds of incidents.
        if (ws.readyState === OPEN) {
          rejected.floodClosed++;
          ws.close(1008, 'rate-limited');
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      // JSON.parse returns any type, not just an object: `null`, a number, a
      // string. The try/catch above covers ONLY the parse — `msg.type` on `null` threw
      // out of the handler, hence uncaughtException, hence the process dies along with all the rooms.
      if (!msg || typeof msg !== 'object') return;
      // Safety net for the handlers: the payload content stays untrusted even once the object
      // is validated (numeric code, object pseudo…). An unexpected value must never get past
      // the connection that sent it. Counted, not logged — the signaling writes nothing to
      // disk, and a flooder would grow Docker's json-file without bound.
      try {
        switch (msg.type) {
          case 'create':
            return onCreate(client);
          case 'join':
            return onJoin(client, msg);
          case 'reclaim':
            return onReclaim(client, msg);
          case 'signal':
            return onSignal(client, msg); // also serves the ICE restart
          case 'kick':
            return onKickBan(client, msg, false);
          case 'ban':
            return onKickBan(client, msg, true);
          case 'leave':
            return onLeave(client, grace);
        }
      } catch {
        rejected.handlerError++;
      }
    });

    ws.on('close', () => cleanup(client, grace));
    ws.on('error', () => cleanup(client, grace));
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createSignalingServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} already in use. Restart with another port: PORT=8090 pnpm start`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, () => {
    console.log(`signaling on http://localhost:${PORT}  (test client: /test.html)`);
    console.log(`iceServers:`, ICE_SERVERS.map((s) => s.urls).join(', '));
  });
}
