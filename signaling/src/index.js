// Stream-Share signaling server: registre de salons en mémoire + relais aveugle
// des messages WebRTC (SDP/ICE). Aucun média ne transite ici. Cf. docs/signaling-server.md.
//
// Run:  node src/index.js   (puis ouvrir http://localhost:8080/test.html dans 2 onglets)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { newCode, format, normalize, isBanned } from './rooms.js';

const PORT = Number(process.env.PORT) || 8080;
// Délai laissé au host pour se reconnecter (reclaim) avant destruction du salon.
let graceMs = Number(process.env.GRACE_MS) || 30_000;
const ICE_SERVERS = (process.env.ICE_SERVERS || 'stun:stun.l.google.com:19302')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean)
  .map((urls) => ({ urls }));

const here = dirname(fileURLToPath(import.meta.url));
const OPEN = 1; // WebSocket.OPEN

/** @typedef {{ code: string, hostId: string, hostToken: string, viewers: Map<string, {id:string,pseudo:string}>, bannedIps: Set<string>, bannedTokens: Set<string>, createdAt: number, graceTimer: NodeJS.Timeout | null }} Room */
const rooms = new Map(); // code canonique -> Room
const clients = new Map(); // peerId -> { id, ws, ip, token, roomCode, role }

let seq = 0;
const genId = () => `p${++seq}`;

// create rate-limit : fenêtre glissante par IP (ponytail: en mémoire, pas de lib).
const createLog = new Map();
const CREATE_MAX = 10;
const CREATE_WINDOW = 60_000;
function allowCreate(ip, now) {
  const hits = (createLog.get(ip) || []).filter((t) => now - t < CREATE_WINDOW);
  if (hits.length >= CREATE_MAX) {
    createLog.set(ip, hits);
    return false;
  }
  hits.push(now);
  createLog.set(ip, hits);
  return true;
}

function send(ws, type, payload = {}) {
  if (ws.readyState === OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

function onCreate(client) {
  const now = Date.now();
  if (!allowCreate(client.ip, now)) return send(client.ws, 'error', { reason: 'rate-limited' });
  const code = newCode(rooms);
  const hostToken = randomUUID(); // secret pour reprendre la main (reclaim) après une coupure
  rooms.set(code, { code, hostId: client.id, hostToken, viewers: new Map(), bannedIps: new Set(), bannedTokens: new Set(), createdAt: now, graceTimer: null });
  client.roomCode = code;
  client.role = 'host';
  send(client.ws, 'created', { code, display: format(code), hostToken, iceServers: ICE_SERVERS });
}

// Le host reprend son salon après une coupure, dans la fenêtre de grâce, via son hostToken.
function onReclaim(client, { code, hostToken }) {
  const room = rooms.get(normalize(code || ''));
  // Réclamable seulement si le salon existe, est en grâce (host absent) et le token correspond.
  if (!room || !room.graceTimer || room.hostToken !== hostToken) {
    return send(client.ws, 'reclaim-error', { reason: 'invalid' });
  }
  clearTimeout(room.graceTimer);
  room.graceTimer = null;
  // Continuité du peerId : le host reprend son ancien id pour que les `signal {to: hostId}`
  // envoyés par les viewers continuent de router vers lui.
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
  const room = rooms.get(normalize(code));
  if (!room) return send(client.ws, 'join-error', { reason: 'not-found' });
  if (isBanned(room, client.ip, token)) return send(client.ws, 'join-error', { reason: 'banned' });
  client.roomCode = room.code;
  client.role = 'viewer';
  client.token = token || '';
  const name = (pseudo || 'viewer').slice(0, 20);
  room.viewers.set(client.id, { id: client.id, pseudo: name });
  send(client.ws, 'joined', { hostId: room.hostId, iceServers: ICE_SERVERS });
  const host = clients.get(room.hostId);
  if (host) send(host.ws, 'peer-joined', { peerId: client.id, pseudo: name });
}

// Relais aveugle : le serveur ne lit pas `data`, il le recopie vers le pair cible du même salon.
function onSignal(client, { to, data }) {
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
    room.bannedIps.add(viewer.ip);
    if (viewer.token) room.bannedTokens.add(viewer.token);
  }
  room.viewers.delete(peerId);
  viewer.roomCode = null;
  send(viewer.ws, 'kicked', { banned: ban });
  try {
    viewer.ws.close();
  } catch {}
}

function cleanup(client) {
  // Si la map ne référence plus CET objet sous cet id (host reclaimé sous le même id, ou
  // second cleanup via close+error), on ne touche à rien : sinon on supprimerait le reclaimé.
  if (clients.get(client.id) !== client) return;
  clients.delete(client.id);
  const room = rooms.get(client.roomCode);
  client.roomCode = null;
  if (!room) return;
  if (client.role === 'host' && room.hostId === client.id) {
    // Délai de grâce : on garde le salon vivant pour laisser le host se reconnecter (reclaim).
    // Les viewers ne sont pas notifiés tant que la grâce n'a pas expiré.
    room.graceTimer = setTimeout(() => destroyRoom(room), graceMs);
    room.graceTimer.unref(); // ne pas maintenir le process en vie juste pour ce timer
  } else {
    room.viewers.delete(client.id);
    const host = clients.get(room.hostId);
    if (host) send(host.ws, 'peer-left', { peerId: client.id });
  }
}

// Départ explicite (l'utilisateur a cliqué Stop/Quitter) : volontaire, donc on termine tout
// de suite — contrairement à une coupure de socket inattendue, qui ouvre au host une fenêtre
// de grâce pour reclaim.
function onLeave(client) {
  const room = rooms.get(client.roomCode);
  if (room && client.role === 'host' && room.hostId === client.id) {
    if (room.graceTimer) clearTimeout(room.graceTimer);
    destroyRoom(room); // notifie les viewers (peer-left host-left) + libère le code, sans grâce
  }
  cleanup(client); // retire le client ; pour un viewer, notifie aussi l'host
}

export function createSignalingServer(opts = {}) {
  if (opts.graceMs != null) graceMs = opts.graceMs;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/test.html')) {
      try {
        const html = readFileSync(join(here, '..', 'public', 'test.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch {
        res.writeHead(404);
        return res.end('test.html introuvable');
      }
    }
    res.writeHead(404);
    res.end('not found');
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const client = { id: genId(), ws, ip, token: '', roomCode: null, role: null };
    clients.set(client.id, client);
    send(ws, 'hello', { peerId: client.id });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'create':
          return onCreate(client);
        case 'join':
          return onJoin(client, msg);
        case 'reclaim':
          return onReclaim(client, msg);
        case 'signal':
          return onSignal(client, msg); // sert aussi à l'ICE restart
        case 'kick':
          return onKickBan(client, msg, false);
        case 'ban':
          return onKickBan(client, msg, true);
        case 'leave':
          return onLeave(client);
      }
    });

    ws.on('close', () => cleanup(client));
    ws.on('error', () => cleanup(client));
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createSignalingServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} déjà utilisé. Relance avec un autre port : PORT=8090 pnpm start`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, () => {
    console.log(`signaling on http://localhost:${PORT}  (test client: /test.html)`);
    console.log(`iceServers:`, ICE_SERVERS.map((s) => s.urls).join(', '));
  });
}
