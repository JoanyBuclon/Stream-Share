// Integration test: kick + ban. Prouve que le ban tient à l'IP (changer de token n'évade pas).
// Run: node src/ban.test.js
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
const j = (obj) => JSON.stringify(obj);

const host = await open(url);
const hostNext = reader(host);
host.send(j({ type: 'create' }));
const created = await until(hostNext, 'created');

// Un viewer rejoint avec le token 'A', le host le bannit.
const v1 = await open(url);
const v1Next = reader(v1);
v1.send(j({ type: 'join', code: created.code, pseudo: 'troll', token: 'A' }));
await until(v1Next, 'joined');
const viewerId = (await until(hostNext, 'peer-joined')).peerId;
host.send(j({ type: 'ban', peerId: viewerId }));
const kicked = await until(v1Next, 'kicked');
assert.equal(kicked.banned, true);

// Le banni revient avec un token DIFFÉRENT ('B') : même IP (localhost) → toujours banni.
const v2 = await open(url);
const v2Next = reader(v2);
v2.send(j({ type: 'join', code: created.code, pseudo: 'troll2', token: 'B' }));
const err = await until(v2Next, 'join-error');
assert.equal(err.reason, 'banned', 'changer de token n\'évade pas le ban (attrapé par l\'IP)');

host.close();
v1.close();
v2.close();
await new Promise((r) => server.close(r));
console.log('ban.test.js OK');
