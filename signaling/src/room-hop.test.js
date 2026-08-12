// One socket, one room — the guard `join` and `reclaim` were missing (`create` always had it).
//
// Each assertion below is a PoC that PASSED against the previous revision. Together they were a
// remotely exploitable DoS: a viewer entry that survives its socket holds a MAX_VIEWERS slot no one
// can free (onKickBan resolves the peer through `clients`, where it no longer is), and a host that
// walks away from its room leaves the room itself uncollectable. See `alreadyInRoom` in index.js.
//
// Bracketed with _resetState() like the sibling files: the room/client maps and the rate-limit
// budget are module-global and shared across test files.
import assert from 'node:assert/strict';
// The `ws` client, not the global WebSocket: only this one lets a connection carry its own headers,
// which is how a socket here presents a client IP. See the TRUST_PROXY note below.
import { WebSocket } from 'ws';

// Set BEFORE index.js is loaded — it reads TRUST_PROXY at module scope — hence the dynamic import.
//
// It exists for the ban assertions at the bottom, and it is load-bearing rather than convenience:
// `isBanned` (rooms.js) short-circuits on `bannedIps`, so a ban issued and re-tested from the same
// address is refused by the IP whatever the token does. Every socket in a single-process test comes
// from 127.0.0.1, so the token half of the ban was unreachable — measured: reverting the token fix
// entirely left the previous version of this file green. X-Forwarded-For gives each socket its own
// address and makes the token the only thing that can refuse it.
process.env.TRUST_PROXY = '1';
const { createSignalingServer, _resetState } = await import('./index.js');

_resetState();
// Short grace so the host-leak assertion can outwait it without slowing the suite down.
const GRACE_MS = 150;
const server = createSignalingServer({ graceMs: GRACE_MS });
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `ws://localhost:${port}`;
const health = async () => (await (await fetch(`http://localhost:${port}/health`)).json());

/** One client socket. `ip`, when given, is presented as X-Forwarded-For — see the TRUST_PROXY note. */
function connect(ip) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, ip ? { headers: { 'x-forwarded-for': ip } } : undefined);
    const q = [];
    let waiting = null;
    const api = {
      ws,
      id: null,
      send: (o) => ws.send(JSON.stringify(o)),
      next: () => (q.length ? Promise.resolve(q.shift()) : new Promise((r) => (waiting = r))),
      // Resolves once the socket is really gone. The already-CLOSED check is load-bearing: a banned
      // or kicked viewer is closed BY THE SERVER (onKickBan), and calling close() again on a closed
      // socket is a no-op that fires no further 'close' event — so waiting on one hangs for ever.
      end: () =>
        new Promise((r) => {
          if (ws.readyState === WebSocket.CLOSED) return r();
          ws.once('close', r);
          ws.close();
        }),
    };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'hello') {
        api.id = m.peerId;
        return;
      }
      if (waiting) {
        waiting(m);
        waiting = null;
      } else q.push(m);
    });
    ws.on('open', () => res(api));
    ws.on('error', rej);
  });
}
const until = async (c, ...types) => {
  for (;;) {
    const m = await c.next();
    if (types.includes(m.type)) return m;
  }
};

/** Wait for /health to satisfy `ok`, then return it.
 *
 *  The client's own 'close' resolves as soon as the local socket is gone — the SERVER's close
 *  handler, which is what runs cleanup(), lands slightly after. Asserting straight off `end()`
 *  therefore races the very teardown under test (measured: it read the pre-cleanup count). Where a
 *  server message marks the moment (a host's `peer-left`) the assertions below await that instead;
 *  this covers the host-side departures, which announce nothing to anyone. */
async function settled(ok, what) {
  for (let i = 0; i < 100; i++) {
    const h = await health();
    if (ok(h)) return h;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`/health never settled: ${what}`);
}

// --- Two rooms to hop between ---
const victimHost = await connect();
victimHost.send({ type: 'create' });
const { code: victim } = await until(victimHost, 'created');
const decoyHost = await connect();
decoyHost.send({ type: 'create' });
const { code: decoy } = await until(decoyHost, 'created');

// --- PoC 1: viewer hop. Joining a second room from the same socket is refused, and — the part
// that actually mattered — the viewer stays accounted to exactly one room, so its slot is freed
// when it leaves. Previously the entry in `victim` outlived the socket forever.
const hopper = await connect();
hopper.send({ type: 'join', code: victim, pseudo: 'hopper' });
await until(hopper, 'joined');
hopper.send({ type: 'join', code: decoy, pseudo: 'hopper' });
const refusedJoin = await until(hopper, 'join-error', 'joined');
assert.equal(refusedJoin.type, 'join-error', 'a socket already in a room cannot join a second one');
assert.equal(refusedJoin.reason, 'already-in-room');
assert.equal((await health()).viewers, 1, 'the hop created no second membership');

await hopper.end();
// The host being told IS the server-side cleanup: `peer-left` is sent from inside cleanup(), right
// after `room.viewers.delete`. Awaiting it removes the race AND asserts the other half — a ghost
// the host cannot kick is also one it never sees leave.
assert.equal((await until(victimHost, 'peer-left')).peerId, hopper.id);
assert.equal((await health()).viewers, 0, 'leaving frees the slot — no ghost survives the socket');

// --- PoC 2: the reclaim variant. Cheapest of the three, and the only one that also moves
// `client.id` — which is precisely what stranded the previous entry beyond cleanup's reach.
const reclaimer = await connect();
reclaimer.send({ type: 'create' });
const own = await until(reclaimer, 'created');
await reclaimer.end(); // its room enters grace; it keeps the hostToken

const parked = await connect();
parked.send({ type: 'join', code: victim, pseudo: 'parked' });
await until(parked, 'joined');
parked.send({ type: 'reclaim', code: own.code, hostToken: own.hostToken });
const refusedReclaim = await until(parked, 'reclaim-error', 'reclaimed');
assert.equal(refusedReclaim.type, 'reclaim-error', 'a socket already in a room cannot reclaim another');
assert.equal(refusedReclaim.reason, 'already-in-room');
await parked.end();
await until(victimHost, 'peer-left'); // same synchronisation as above
assert.equal((await health()).viewers, 0, 'the parked viewer left with its socket');

// A reclaim from a FRESH socket still works — the guard must not have broken the reconnect path,
// which is the whole reason grace exists.
const reconnected = await connect();
reconnected.send({ type: 'reclaim', code: own.code, hostToken: own.hostToken });
assert.equal((await until(reconnected, 'reclaimed', 'reclaim-error')).type, 'reclaimed', 'reclaim on a fresh socket still works');
await reconnected.end();

// --- PoC 3: the room leak. A host that created a room and then walked away used to leave the room
// itself alive with no socket and no graceTimer — never destroyed by any path.
// Only victimHost and decoyHost are still connected; `own` is mid-grace after `reconnected` left,
// so wait for it to be destroyed rather than assuming a count.
const baseline = (await settled((h) => h.connections === 2 && h.rooms === 2, 'the reclaimed room to expire')).rooms;
const leaker = await connect();
leaker.send({ type: 'create' });
await until(leaker, 'created');
leaker.send({ type: 'join', code: decoy, pseudo: 'leaker' });
assert.equal((await until(leaker, 'join-error', 'joined')).reason, 'already-in-room', 'a host cannot join elsewhere');
assert.equal((await health()).rooms, baseline + 1, 'the room exists while its host is connected');
await leaker.end();
// Its own grace has to elapse before destroyRoom runs — that is the legitimate path, and the one
// the orphaned room never reached because cleanup() had already lost track of the room entirely.
await settled((h) => h.rooms === baseline, 'the abandoned room to be destroyed');

// --- PoC 4: the same ghost from a DEREGISTERED client — `leave`, then `join`, in one TCP write.
//
// This is the one the alreadyInRoom guard cannot see: `cleanup` nulls `roomCode`, so the guard is
// asked "already in a room?" and answers "no", honestly and uselessly. `cleanup` also removes the
// client from `clients` — and closing the socket is NOT enough, because `ws.close()` opens a CLOSING
// handshake and goes on delivering frames that were already in flight. So a `join` sent back to back
// with the `leave`, with no round trip in between, still reached its handler and re-parked an entry
// under an id `clients` no longer knew. At the real close, `cleanup` bailed at
// `clients.get(client.id) !== client` and never removed it.
//
// **Asserted on the invariant, not on the consequence.** The earlier version of this test only
// checked that the socket eventually closed — which was true, and passed, while the exploit stayed
// wide open: measured 3 sockets → `viewers: 3` with `connections: 1`, and the `create` variant left
// 3 rooms with no host and no graceTimer, which nothing destroys. Hence no await below between the
// two sends: awaiting anything is precisely what would hide the bug.
const roomsBeforeLeave = (await health()).rooms;
const leaver = await connect();
leaver.send({ type: 'join', code: victim, pseudo: 'leaver' });
await until(leaver, 'joined');
await until(victimHost, 'peer-joined');
leaver.send({ type: 'leave' });
leaver.send({ type: 'join', code: victim, pseudo: 'ghost' }); // same write — a deregistered client must be inert
leaver.send({ type: 'create' }); // …for every verb, not just the one this bug was found through
await until(victimHost, 'peer-left');
await settled((h) => h.viewers === 0, 'the leaver to free its slot');
assert.equal((await health()).viewers, 0, 'a deregistered client cannot re-park a viewer entry');
assert.equal((await health()).rooms, roomsBeforeLeave, 'nor open a room nothing can ever destroy');

// --- P1-6: the ban token is typed and bounded.
//
// Every socket below carries its OWN address, because that is the only way these assertions say
// anything: `isBanned` short-circuits on `bannedIps`, so re-testing a ban from the address that
// earned it proves nothing about the token. The previous version of this block did exactly that
// and stayed green with the fix reverted.
const banHost = await connect();
banHost.send({ type: 'create' });
const { code: banRoom } = await until(banHost, 'created');

// BOUNDED. A 30 000-character token is stored cut to MAX_TOKEN_LEN, so its 100-character prefix is
// the same ban key — an equality that only holds if the slice actually happened.
const long = await connect('198.51.100.1');
long.send({ type: 'join', code: banRoom, pseudo: 'long', token: 'z'.repeat(30_000) });
await until(long, 'joined');
banHost.send({ type: 'ban', peerId: long.id });
await until(long, 'kicked');

const prefix = await connect('198.51.100.2'); // unbanned address: only the token can refuse this one
prefix.send({ type: 'join', code: banRoom, pseudo: 'prefix', token: 'z'.repeat(100) });
assert.equal((await until(prefix, 'joined', 'join-error')).reason, 'banned', 'the ban key stored is the TRUNCATED token');
await prefix.end();

// …and a different token from an unbanned address still gets in, so the refusal above is the token
// matching rather than something turning everyone away.
const other = await connect('198.51.100.3');
other.send({ type: 'join', code: banRoom, pseudo: 'other', token: 'y'.repeat(100) });
assert.equal((await until(other, 'joined', 'join-error')).type, 'joined', 'an unrelated token is not caught by the ban');
await other.end();
await long.end();

// TYPED. A non-string is coerced to '' and never becomes a ban key — `isBanned`'s `!!token` then
// skips the token check entirely. Worth naming honestly: this NARROWS the ban (a numeric token used
// to match itself) rather than closing a bypass. What it buys is that arbitrary JSON from the wire
// can no longer be parked in `bannedTokens` for the life of the room.
const objTok = await connect('198.51.100.4');
objTok.send({ type: 'join', code: banRoom, pseudo: 'obj', token: { evil: 1 } });
await until(objTok, 'joined');
banHost.send({ type: 'ban', peerId: objTok.id });
await until(objTok, 'kicked');

const objAgain = await connect('198.51.100.5');
objAgain.send({ type: 'join', code: banRoom, pseudo: 'obj2', token: { evil: 1 } });
assert.equal((await until(objAgain, 'joined', 'join-error')).type, 'joined', 'no non-string ever became a ban key');
await objAgain.end();
await objTok.end();

for (const c of [victimHost, decoyHost, banHost]) await c.end();
await new Promise((r) => server.close(r));
_resetState();
console.log('room-hop.test.js OK');
