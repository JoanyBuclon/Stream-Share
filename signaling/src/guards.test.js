// Gardes S1 (IP réelle), S2 (Origin), S3 (payload + throttle).
// Run: node src/guards.test.js
import assert from 'node:assert/strict';
import { clientIp, originAllowed, createSignalingServer } from './index.js';

// S1 — X-Forwarded-For n'est lu que si le proxy est de confiance, et seul le dernier hop
// (celui ajouté par le proxy) compte : les précédents sont fournis par le client.
const req = (xff, socketIp = '10.0.0.1') => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: socketIp } });
assert.equal(clientIp(req('203.0.113.9'), true), '203.0.113.9');
assert.equal(clientIp(req('1.2.3.4, 203.0.113.9'), true), '203.0.113.9', 'un XFF usurpé par le client ne prime pas sur le hop du proxy');
assert.equal(clientIp(req('203.0.113.9'), false), '10.0.0.1', 'sans TRUST_PROXY, XFF est ignoré');
assert.equal(clientIp(req(null), true), '10.0.0.1');

// S2 — allow-list exacte, pas de sous-chaîne.
const list = ['https://stream.joanybuclon.com'];
assert.equal(originAllowed('https://stream.joanybuclon.com', list), true);
assert.equal(originAllowed('https://stream.joanybuclon.com.evil.net', list), false);
assert.equal(originAllowed('https://evil.net', list), false);
assert.equal(originAllowed(undefined, list), true, 'client non-navigateur : pas de vecteur CSWSH');
assert.equal(originAllowed('https://evil.net', []), true, 'allow-list vide = non configuré (dev)');

const server = createSignalingServer();
await new Promise((r) => server.listen(0, r));
const url = `ws://localhost:${server.address().port}`;

const open = () =>
  new Promise((res, rej) => {
    const s = new WebSocket(url);
    s.onopen = () => res(s);
    s.onerror = rej;
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
const until = async (next, ...types) => {
  for (;;) {
    const m = await next();
    if (types.includes(m.type)) return m;
  }
};
const j = (o) => JSON.stringify(o);

// S4 — le 11ᵉ viewer est refusé (MAX_VIEWERS = 10 par défaut).
const host = await open();
const hostNext = reader(host);
host.send(j({ type: 'create' }));
const { code } = await until(hostNext, 'created');

const viewers = [];
for (let i = 0; i < 10; i++) {
  const v = await open();
  const next = reader(v);
  v.send(j({ type: 'join', code, pseudo: `v${i}` }));
  assert.equal((await until(next, 'joined', 'join-error')).type, 'joined', `viewer ${i} sous le plafond`);
  viewers.push(v);
}
const extra = await open();
const extraNext = reader(extra);
extra.send(j({ type: 'join', code, pseudo: 'v10' }));
assert.equal((await until(extraNext, 'joined', 'join-error')).reason, 'full', 'le 11ᵉ est refusé');

// S5 — le balayage de codes s'épuise : un `join` répété finit rate-limited, même sur des
// codes inexistants (sinon les essais ratés seraient gratuits).
let limited = false;
for (let i = 0; i < 40 && !limited; i++) {
  extra.send(j({ type: 'join', code: 'ZZZZZZ' }));
  limited = (await until(extraNext, 'join-error')).reason === 'rate-limited';
}
assert.ok(limited, 'le join finit par être rate-limited');

// S3 — un flood ferme la connexion.
const flooder = await open();
const closed = new Promise((r) => (flooder.onclose = (e) => r(e.code)));
for (let i = 0; i < 200; i++) flooder.send(j({ type: 'signal', to: 'nobody' }));
assert.equal(await closed, 1008, 'au-delà du seuil, la connexion est fermée');

host.close();
extra.close();
for (const v of viewers) v.close();
await new Promise((r) => server.close(r));
console.log('guards.test.js OK');
