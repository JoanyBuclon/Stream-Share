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
// Derrière Traefik uniquement (cf. docker-compose.yml). En écoute directe, laisser à 0 :
// X-Forwarded-For est alors entièrement contrôlé par le client.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const MAX_VIEWERS = Number(process.env.MAX_VIEWERS) || 10;
const MAX_PAYLOAD = 64 * 1024; // SDP/ICE tiennent dans quelques Ko
const MSG_MAX_PER_SEC = 60; // au-delà, la connexion est fermée
const HEARTBEAT_MS = 30_000; // ping toutes les 30 s ; une socket sans pong au tour suivant est morte

const here = dirname(fileURLToPath(import.meta.url));
const OPEN = 1; // WebSocket.OPEN

/** @typedef {{ code: string, hostId: string, hostToken: string, viewers: Map<string, {id:string,pseudo:string}>, bannedIps: Set<string>, bannedTokens: Set<string>, createdAt: number, graceTimer: NodeJS.Timeout | null }} Room */
const rooms = new Map(); // code canonique -> Room
const clients = new Map(); // peerId -> { id, ws, ip, token, roomCode, role }

let seq = 0;
const genId = () => `p${++seq}`;

// Rate-limit par IP : fenêtre glissante en mémoire (ponytail: pas de lib, pas de Redis).
// `join` est bridé pour rendre le balayage de codes non praticable (32⁶ codes / 30 essais
// par minute et par IP). Les IP viennent de `clientIp`, donc réelles derrière le proxy.
const RATE = {
  create: { log: new Map(), max: 10, window: 60_000 },
  join: { log: new Map(), max: 30, window: 60_000 },
};
// Compteurs cumulés depuis le démarrage, exposés par /health. Ce sont les rejets qui disent si
// on se fait taper dessus — `rooms`/`viewers` ne disent que si le service sert. Volontairement
// des entiers plats : pas de série temporelle ici, c'est le rôle de ce qui scrape.
const rejected = { createRateLimited: 0, joinRateLimited: 0, originRejected: 0, floodClosed: 0, banned: 0, handlerError: 0 };

function allow(kind, ip, now) {
  const { log, max, window } = RATE[kind];
  const hits = (log.get(ip) || []).filter((t) => now - t < window);
  log.set(ip, hits);
  if (hits.length >= max) return false;
  hits.push(now);
  return true;
}

// Sans ceci, une clé par IP jamais revue reste à vie (les timestamps sont filtrés à la
// lecture, mais la lecture n'arrive plus). Balayage à la fréquence de la fenêtre.
setInterval(() => {
  const now = Date.now();
  for (const { log, window } of Object.values(RATE)) {
    for (const [ip, hits] of log) if (hits.every((t) => now - t >= window)) log.delete(ip);
  }
}, 60_000).unref();

/** IP réelle du client. Derrière le proxy, le *dernier* hop de X-Forwarded-For est celui
 *  ajouté par Traefik (l'adresse socket vue par lui) ; les entrées précédentes viennent du
 *  client et sont donc usurpables. Sans TRUST_PROXY, l'en-tête n'est jamais lu. */
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

/** Anti-CSWSH. Origin absent = client non-navigateur (tests, CLI) : rien à usurper, on laisse
 *  passer — le vecteur CSWSH n'existe que dans un navigateur, qui envoie toujours l'en-tête.
 *  Allow-list vide = non configuré (dev) : pas de contrôle. */
export function originAllowed(origin, list = ALLOWED_ORIGINS) {
  if (!list.length || !origin) return true;
  return list.includes(origin);
}

function send(ws, type, payload = {}) {
  if (ws.readyState === OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

function onCreate(client) {
  // Une socket ne tient qu'un salon. Sans ce garde, un second `create` écrase `client.roomCode`
  // et le salon précédent devient orphelin : `cleanup` ne collecte que le dernier, les autres
  // vivent sans host jusqu'à l'OOM et leur code sort du pool. Le front n'ouvre jamais deux
  // salons sur une même socket (app.ts).
  if (client.roomCode) return send(client.ws, 'error', { reason: 'already-in-room' });
  const now = Date.now();
  if (!allow('create', client.ip, now)) {
    rejected.createRateLimited++;
    return send(client.ws, 'error', { reason: 'rate-limited' });
  }
  const code = newCode(rooms);
  const hostToken = randomUUID(); // secret pour reprendre la main (reclaim) après une coupure
  rooms.set(code, { code, hostId: client.id, hostToken, viewers: new Map(), bannedIps: new Set(), bannedTokens: new Set(), createdAt: now, graceTimer: null });
  client.roomCode = code;
  client.role = 'host';
  send(client.ws, 'created', { code, display: format(code), hostToken, iceServers: ICE_SERVERS });
}

// Le host reprend son salon après une coupure, dans la fenêtre de grâce, via son hostToken.
function onReclaim(client, { code, hostToken }) {
  const room = rooms.get(normalize(code));
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
  // Compté avant toute vérification : un balayeur ne doit pas obtenir d'essais gratuits
  // sur les codes inexistants — ce sont justement ceux qu'il envoie en masse.
  if (!allow('join', client.ip, Date.now())) {
    rejected.joinRateLimited++;
    return send(client.ws, 'join-error', { reason: 'rate-limited' });
  }
  const room = rooms.get(normalize(code));
  if (!room) return send(client.ws, 'join-error', { reason: 'not-found' });
  if (isBanned(room, client.ip, token)) return send(client.ws, 'join-error', { reason: 'banned' });
  // Le mesh (un flux encodé par viewer côté host) ne tient pas au-delà d'une poignée :
  // le plafond protège autant le navigateur du host que la mémoire du serveur.
  if (room.viewers.size >= MAX_VIEWERS) return send(client.ws, 'join-error', { reason: 'full' });
  client.roomCode = room.code;
  client.role = 'viewer';
  client.token = token || '';
  // `String()` : `pseudo` vient de JSON.parse, donc de n'importe quel type — un nombre jetait
  // sur `.slice`. Le cap à 20 est la seule borne côté serveur, le front n'en pose aucune.
  const name = String(pseudo ?? 'viewer').slice(0, 20);
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
    rejected.banned++;
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
    // Volontairement NON routé par Traefik (qui n'envoie ici que Host + PathPrefix(/ws)) : joignable
    // seulement depuis le réseau Docker et le healthcheck du compose. C'est ce qui permet d'exposer
    // les compteurs sans réfléchir — les publier donnerait à un attaquant un retour direct sur
    // l'effet de ses tentatives. Ne pas ajouter de router `/health` sans repasser sur ce choix.
    if (req.method === 'GET' && req.url === '/health') {
      let viewers = 0;
      for (const room of rooms.values()) viewers += room.viewers.size;
      res.writeHead(200, { 'content-type': 'application/json' });
      // `connections` compte toutes les sockets ouvertes, y compris celles qui n'ont encore ni
      // créé ni rejoint : un écart durable avec rooms+viewers signale des clients qui traînent.
      return res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, viewers, connections: clients.size, rejected }));
    }
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

    // Throttle par connexion : fenêtre fixe d'une seconde. Au-delà du seuil on ferme au lieu
    // de jeter le message — un `signal` perdu en silence casserait la négociation ICE, alors
    // qu'une fermeture est un échec visible que le client sait gérer (reconnexion).
    let windowStart = 0;
    let msgCount = 0;

    ws.on('message', (raw) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        msgCount = 0;
      }
      if (++msgCount > MSG_MAX_PER_SEC) {
        // `close()` ne vide pas ce qui est déjà en tampon : le handler continue de tirer pour
        // chaque message restant. Se fier à readyState compte UNE fermeture par connexion (et
        // évite de re-fermer) — sinon un seul flooder gonfle le compteur du nombre de messages
        // qu'il a réussi à empiler, et /health laisse croire à des centaines d'incidents.
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
      // JSON.parse rend n'importe quel type, pas seulement un objet : `null`, un nombre, une
      // chaîne. Le try/catch ci-dessus ne couvre QUE le parse — `msg.type` sur `null` jetait
      // hors du handler, donc uncaughtException, donc le process meurt avec tous les salons.
      if (!msg || typeof msg !== 'object') return;
      // Filet pour les handlers : le contenu du payload reste non fiable même une fois l'objet
      // validé (code numérique, pseudo objet…). Une valeur inattendue ne doit jamais dépasser
      // la connexion qui l'a envoyée. Compté, pas loggué — le signaling n'écrit rien sur
      // disque, et un flooder ferait grossir le fichier json-file de Docker sans borne.
      try {
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
      } catch {
        rejected.handlerError++;
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
