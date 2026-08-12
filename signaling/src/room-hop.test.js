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
import { createSignalingServer, _resetState } from './index.js';

_resetState();
// Short grace so the host-leak assertion can outwait it without slowing the suite down.
const GRACE_MS = 150;
const server = createSignalingServer({ graceMs: GRACE_MS });
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `ws://localhost:${port}`;
const health = async () => (await (await fetch(`http://localhost:${port}/health`)).json());

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
      // Resolves once the socket is really gone. The already-CLOSED check is load-bearing: a banned
      // or kicked viewer is closed BY THE SERVER (onKickBan), and calling close() again on a closed
      // socket is a no-op that fires no further 'close' event — so waiting on one hangs for ever.
      end: () =>
        new Promise((r) => {
          if (ws.readyState === WebSocket.CLOSED) return r();
          ws.onclose = r;
          ws.close();
        }),
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

// --- PoC 4: the same ghost, reached the other way round — `leave` then `join`, on one socket.
// The alreadyInRoom guard does NOT catch this one: `cleanup` sets `roomCode` to null, so the guard
// sees a clean client. What it does not do is close the socket, and it DOES delete the client from
// `clients` — leaving an object that can still send messages but is no longer reachable. A second
// join then parked a viewer entry that the close handler's `cleanup` refuses to touch (it bails at
// `clients.get(client.id) !== client`), so the ghost outlived the socket exactly as before.
// Measured on the guarded-but-unclosed revision: `viewers: 1` with the socket gone.
const leaver = await connect();
leaver.send({ type: 'join', code: victim, pseudo: 'leaver' });
await until(leaver, 'joined');
await until(victimHost, 'peer-joined');
leaver.send({ type: 'leave' });
// The server now ends the connection itself, which is the fix: no orphaned-but-live socket exists
// to send a second join from. Raced against a deadline rather than simply awaited — without the
// fix this close never comes, and a test that hangs says far less at 3am than one that names the
// invariant it lost.
const closedOnLeave = await Promise.race([
  new Promise((r) => {
    if (leaver.ws.readyState === WebSocket.CLOSED) return r(true);
    leaver.ws.onclose = () => r(true);
  }),
  // unref'd: once the race is settled this timer is dead weight, and an un-unref'd one holds the
  // event loop open for its full 2 s at the end of the file — 2 s added to every CI run for nothing.
  new Promise((r) => setTimeout(() => r(false), 2000).unref()),
]);
assert.ok(closedOnLeave, 'leave must end the connection — an open one is an orphan waiting to re-join');
await until(victimHost, 'peer-left');
assert.equal((await health()).viewers, 0, 'leave frees the slot and leaves no orphan behind');

// --- P1-6: the ban token is typed and bounded. A non-string used to reach `bannedTokens`, where
// `isBanned`'s `!!token` accepts it but no equality ever matches — silently disarming the ban path
// that exists for the CGNAT case. Unbounded, it also parked up to MAX_PAYLOAD per ban.
const banHost = await connect();
banHost.send({ type: 'create' });
const { code: banRoom } = await until(banHost, 'created');

const objectToken = await connect();
objectToken.send({ type: 'join', code: banRoom, pseudo: 'obj', token: { evil: 1 } });
await until(objectToken, 'joined');
banHost.send({ type: 'ban', peerId: objectToken.id });
await until(objectToken, 'kicked');
// The ban still lands (by IP — same host here), and crucially nothing unstringlike was stored.
const rejoin = await connect();
rejoin.send({ type: 'join', code: banRoom, pseudo: 'obj-again', token: { evil: 1 } });
assert.equal((await until(rejoin, 'join-error', 'joined')).reason, 'banned', 'a non-string token does not slip past the ban');
await rejoin.end();
await objectToken.end();

const longToken = await connect();
longToken.send({ type: 'join', code: banRoom, pseudo: 'long', token: 'z'.repeat(30_000) });
assert.equal((await until(longToken, 'joined', 'join-error')).type, 'join-error', 'same IP is still banned');
await longToken.end();

for (const c of [victimHost, decoyHost, banHost]) await c.end();
await new Promise((r) => server.close(r));
_resetState();
console.log('room-hop.test.js OK');
