// Authorization + room isolation: kick is host-only, a plain kick doesn't ban, and the signal relay
// never crosses room boundaries. These guards protect against a viewer expelling peers or a viewer
// in one room injecting SDP into another. Bracketed with _resetState() so this file stays isolated
// from the shared module-global state (rooms, rate-limit budget) the other test files also touch.
import assert from 'node:assert/strict';
import { createSignalingServer, _resetState } from './index.js';

_resetState();
const server = createSignalingServer();
await new Promise((r) => server.listen(0, r));
const url = `ws://localhost:${server.address().port}`;

// Each socket captures its own peerId from `hello` and queues the rest for `next()`.
function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const q = [];
    let waiting = null;
    const api = {
      ws,
      id: null,
      send: (o) => ws.send(JSON.stringify(o)),
      next: () => (q.length ? Promise.resolve(q.shift()) : new Promise((r) => (waiting = r))),
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'hello') {
        api.id = m.peerId;
        return;
      }
      if (waiting) {
        waiting(m);
        waiting = null;
      } else q.push(m);
    };
    ws.onopen = () => res(api);
    ws.onerror = rej;
  });
}
const until = async (c, ...types) => {
  for (;;) {
    const m = await c.next();
    if (types.includes(m.type)) return m;
  }
};

// --- Room 1: host + two viewers. Room 2: host + one viewer. ---
const host1 = await connect();
host1.send({ type: 'create' });
const { code: code1 } = await until(host1, 'created');
const a1 = await connect();
a1.send({ type: 'join', code: code1, pseudo: 'a1' });
await until(a1, 'joined');
const a2 = await connect();
a2.send({ type: 'join', code: code1, pseudo: 'a2' });
await until(a2, 'joined');

const host2 = await connect();
host2.send({ type: 'create' });
const { code: code2 } = await until(host2, 'created');
const b1 = await connect();
b1.send({ type: 'join', code: code2, pseudo: 'b1' });
await until(b1, 'joined');

// A viewer is not the host: its kick must be ignored. Prove a2 is still in the room by relaying a
// signal to it from the host afterwards — if a2 had been kicked, its roomCode would be null and the
// onSignal room guard would drop the relay.
a1.send({ type: 'kick', peerId: a2.id });
host1.send({ type: 'signal', to: a2.id, data: { ping: 1 } });
const relayed = await until(a2, 'signal');
assert.equal(relayed.from, host1.id, 'a2 still receives host relay → the non-host kick was ignored');

// The relay never crosses rooms: a1 (room 1) signalling b1 (room 2) must not reach b1. Send the
// cross-room signal, then a legit one from b1's own host; b1's next signal must be the host's, never
// a1's — otherwise SDP would leak between rooms.
a1.send({ type: 'signal', to: b1.id, data: { leak: 1 } });
host2.send({ type: 'signal', to: b1.id, data: { ok: 1 } });
const b1sig = await until(b1, 'signal');
assert.equal(b1sig.from, host2.id, 'b1 only gets its own host relay, not a1 from another room');
assert.deepEqual(b1sig.data, { ok: 1 });

// A plain kick (not ban) removes the viewer but does not ban: it can rejoin the same room.
host1.send({ type: 'kick', peerId: a2.id });
const kicked = await until(a2, 'kicked');
assert.equal(kicked.banned, false, 'kick without ban reports banned:false');
const a2b = await connect();
a2b.send({ type: 'join', code: code1, pseudo: 'a2-again' });
assert.equal((await until(a2b, 'joined', 'join-error')).type, 'joined', 'a kicked (not banned) viewer can rejoin');

for (const c of [host1, a1, a2, host2, b1, a2b]) c.ws.close();
await new Promise((r) => server.close(r));
_resetState(); // leave the shared state clean for the sibling test files
console.log('authz.test.js OK');
