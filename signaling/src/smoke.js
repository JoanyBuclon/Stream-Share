// End-to-end smoke test of the signaling relay — no browser needed.
// Deux clients WebSocket : create -> join -> relais d'un faux SDP -> peer-left.
// Run: node src/smoke.js
import assert from 'node:assert/strict';
import { createSignalingServer } from './index.js';

const server = createSignalingServer();
await new Promise((r) => server.listen(0, r));
const url = `ws://localhost:${server.address().port}`;

const open = (u) =>
  new Promise((res, rej) => {
    const ws = new WebSocket(u);
    ws.onopen = () => res(ws);
    ws.onerror = rej;
  });

// Lecteur bufferisé : ne perd aucun message même si plusieurs arrivent d'affilée.
function reader(ws) {
  const q = [];
  let waiting = null;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (waiting) {
      waiting(m);
      waiting = null;
    } else q.push(m);
  };
  return () => (q.length ? Promise.resolve(q.shift()) : new Promise((r) => (waiting = r)));
}
const until = async (nextMsg, type) => {
  for (;;) {
    const m = await nextMsg();
    if (m.type === type) return m;
  }
};

const host = await open(url);
const hostNext = reader(host);
const viewer = await open(url);
const viewerNext = reader(viewer);

// 1. Host crée un salon.
host.send(JSON.stringify({ type: 'create' }));
const created = await until(hostNext, 'created');
assert.match(created.code, /^[0-9A-HJKMNP-TV-Z]{6}$/);
assert.equal(created.display, `${created.code.slice(0, 3)}-${created.code.slice(3)}`);
assert.ok(Array.isArray(created.iceServers) && created.iceServers.length > 0);

// 2. Viewer rejoint avec le code au format affiché (tiret + minuscules) et un pseudo.
viewer.send(JSON.stringify({ type: 'join', code: created.display.toLowerCase(), pseudo: 'tester', token: 'tok1' }));
const joined = await until(viewerNext, 'joined');
assert.ok(joined.hostId);

const peerJoined = await until(hostNext, 'peer-joined');
assert.equal(peerJoined.pseudo, 'tester');
const viewerId = peerJoined.peerId;

// 3. Relais d'un faux SDP host -> viewer (le serveur ne le lit pas).
host.send(JSON.stringify({ type: 'signal', to: viewerId, data: { sdp: 'FAKE_OFFER' } }));
const relayed = await until(viewerNext, 'signal');
assert.equal(relayed.from, joined.hostId);
assert.equal(relayed.data.sdp, 'FAKE_OFFER');

// 4. Code inconnu -> join-error.
const stranger = await open(url);
const strangerNext = reader(stranger);
stranger.send(JSON.stringify({ type: 'join', code: 'ZZZ-999', pseudo: 'x' }));
const err = await until(strangerNext, 'join-error');
assert.equal(err.reason, 'not-found');
stranger.close();

// 5. Départ viewer -> host notifié.
viewer.close();
const left = await until(hostNext, 'peer-left');
assert.equal(left.peerId, viewerId);

host.close();
await new Promise((r) => server.close(r));
console.log('smoke.js OK');
