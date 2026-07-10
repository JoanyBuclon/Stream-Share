// Integration test: grace host + reclaim. Deux clients WebSocket contre un vrai serveur
// (grâce courte pour ne pas attendre 30 s). Run: node src/grace.test.js
import assert from 'node:assert/strict';
import { createSignalingServer } from './index.js';

const GRACE = 150;
const server = createSignalingServer({ graceMs: GRACE });
await new Promise((r) => server.listen(0, r));
const url = `ws://localhost:${server.address().port}`;

const open = (u) =>
  new Promise((res, rej) => {
    const ws = new WebSocket(u);
    ws.onopen = () => res(ws);
    ws.onerror = rej;
  });

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
const until = async (next, type) => {
  for (;;) {
    const m = await next();
    if (m.type === type) return m;
  }
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (obj) => JSON.stringify(obj);

// --- Scénario 1 : coupure host → grâce → reclaim → continuité du peerId ---
{
  const host = await open(url);
  const hostNext = reader(host);
  host.send(j({ type: 'create' }));
  const created = await until(hostNext, 'created');
  assert.match(created.hostToken, /[0-9a-f-]{36}/, 'hostToken renvoyé au create');

  const viewer = await open(url);
  const viewerNext = reader(viewer);
  viewer.send(j({ type: 'join', code: created.display, pseudo: 'alex', token: 'vtok' }));
  const joined = await until(viewerNext, 'joined');
  const hostId = joined.hostId;
  const viewerId = (await until(hostNext, 'peer-joined')).peerId;

  host.close(); // le host perd son socket
  await delay(40); // laisse le serveur armer la grâce (< GRACE)

  const host2 = await open(url);
  const host2Next = reader(host2);
  host2.send(j({ type: 'reclaim', code: created.code, hostToken: created.hostToken }));
  const reclaimed = await until(host2Next, 'reclaimed');
  assert.deepEqual(reclaimed.viewers, [{ peerId: viewerId, pseudo: 'alex' }], 'liste des viewers restituée');

  // Continuité : le viewer vise toujours l'ancien hostId, ça route vers le host reconnecté.
  viewer.send(j({ type: 'signal', to: hostId, data: { sdp: 'FROM_VIEWER' } }));
  const toHost = await until(host2Next, 'signal');
  assert.equal(toHost.from, viewerId);
  assert.equal(toHost.data.sdp, 'FROM_VIEWER');

  // Et le host reconnecté peut re-signaler au viewer (ex. offre d'ICE restart).
  host2.send(j({ type: 'signal', to: viewerId, data: { sdp: 'RESTART_OFFER' } }));
  const toViewer = await until(viewerNext, 'signal');
  assert.equal(toViewer.data.sdp, 'RESTART_OFFER');

  host2.close();
  viewer.close();
}

// --- Scénario 2 : grâce expirée sans reclaim → viewer notifié peer-left ---
{
  const host = await open(url);
  const hostNext = reader(host);
  host.send(j({ type: 'create' }));
  const created = await until(hostNext, 'created');

  const viewer = await open(url);
  const viewerNext = reader(viewer);
  viewer.send(j({ type: 'join', code: created.code, pseudo: 'marie' }));
  await until(viewerNext, 'joined');
  await until(hostNext, 'peer-joined');

  host.close(); // pas de reclaim → la grâce va expirer
  const left = await until(viewerNext, 'peer-left');
  assert.equal(left.reason, 'host-left');
  viewer.close();
}

// --- Scénario 3 : reclaim avec mauvais token → refusé ---
{
  const host = await open(url);
  const hostNext = reader(host);
  host.send(j({ type: 'create' }));
  const created = await until(hostNext, 'created');
  host.close();
  await delay(40);

  const intruder = await open(url);
  const intruderNext = reader(intruder);
  intruder.send(j({ type: 'reclaim', code: created.code, hostToken: 'mauvais-token' }));
  const err = await until(intruderNext, 'reclaim-error');
  assert.equal(err.reason, 'invalid');
  intruder.close();
}

// --- Scénario 4 : reclaim après expiration de la grâce (salon détruit) → refusé ---
{
  const host = await open(url);
  const hostNext = reader(host);
  host.send(j({ type: 'create' }));
  const created = await until(hostNext, 'created');
  host.close();
  await delay(GRACE + 60); // laisse la grâce expirer → destroyRoom

  const host2 = await open(url);
  const host2Next = reader(host2);
  host2.send(j({ type: 'reclaim', code: created.code, hostToken: created.hostToken }));
  const err = await until(host2Next, 'reclaim-error');
  assert.equal(err.reason, 'invalid');
  host2.close();
}

await new Promise((r) => server.close(r));
console.log('grace.test.js OK');
