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

// S3 — un flood ferme la connexion (et un usage normal, lui, passe).
const server = createSignalingServer();
await new Promise((r) => server.listen(0, r));
const url = `ws://localhost:${server.address().port}`;

const ws = await new Promise((res, rej) => {
  const s = new WebSocket(url);
  s.onopen = () => res(s);
  s.onerror = rej;
});
const closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
for (let i = 0; i < 200; i++) ws.send(JSON.stringify({ type: 'signal', to: 'nobody' }));
assert.equal(await closed, 1008, 'au-delà du seuil, la connexion est fermée');

await new Promise((r) => server.close(r));
console.log('guards.test.js OK');
