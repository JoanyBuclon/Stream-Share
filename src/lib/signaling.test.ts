import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Signaling } from './signaling.ts';

// Fake WebSocket : démarre en CONNECTING, passe à OPEN via emitOpen() (transition réelle).
class FakeSocket {
  readyState = 0; // CONNECTING
  closed = false;
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.fire('close', {});
  }
  private fire(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  emitOpen() {
    this.readyState = 1; // OPEN
    this.fire('open', {});
  }
  emitError() {
    this.fire('error', {});
  }
  emitClose() {
    // coupure côté distant (le socket tombe sans close() local)
    this.readyState = 3;
    this.fire('close', {});
  }
  emitMessage(obj: unknown) {
    this.fire('message', { data: JSON.stringify(obj) });
  }
  emitRaw(data: unknown) {
    this.fire('message', { data });
  }
}

const connected = async () => {
  const sock = new FakeSocket();
  const sig = new Signaling('ws://test', () => sock as unknown as WebSocket);
  const p = sig.connect();
  sock.emitOpen();
  await p;
  return { sig, sock };
};

test('connect résout à l ouverture et dispatche les messages', async () => {
  const { sig, sock } = await connected();
  const got: unknown[] = [];
  sig.onMessage((m) => got.push(m));
  sock.emitMessage({ type: 'hello', peerId: 'p1' });
  assert.deepEqual(got, [{ type: 'hello', peerId: 'p1' }]);
});

test('connect rejette sur erreur d ouverture', async () => {
  const sock = new FakeSocket();
  const sig = new Signaling('ws://test', () => sock as unknown as WebSocket);
  const p = sig.connect();
  sock.emitError();
  await assert.rejects(p);
});

test('connect rejette si le socket se ferme avant de s ouvrir', async () => {
  const sock = new FakeSocket();
  const sig = new Signaling('ws://test', () => sock as unknown as WebSocket);
  const p = sig.connect();
  sock.emitClose(); // fermé sans jamais s'ouvrir (pas d'`error` préalable)
  await assert.rejects(p);
});

test('les méthodes émettent le bon JSON de protocole', async () => {
  const { sig, sock } = await connected();
  sig.create();
  sig.join('7K2-QP9', 'joany', 'tok');
  sig.signal('p2', { sdp: 'x' });
  sig.kick('p2');
  sig.ban('p2');
  sig.leave();
  assert.deepEqual(
    sock.sent.map((s) => JSON.parse(s)),
    [
      { type: 'create' },
      { type: 'join', code: '7K2-QP9', pseudo: 'joany', token: 'tok' },
      { type: 'signal', to: 'p2', data: { sdp: 'x' } },
      { type: 'kick', peerId: 'p2' },
      { type: 'ban', peerId: 'p2' },
      { type: 'leave' },
    ],
  );
});

test('reclaim() émet le JSON attendu; reclaimed / reclaim-error sont dispatchés', async () => {
  const { sig, sock } = await connected();
  sig.reclaim('7K2QP9', 'tok-uuid');
  assert.deepEqual(JSON.parse(sock.sent[0]), { type: 'reclaim', code: '7K2QP9', hostToken: 'tok-uuid' });
  const got: unknown[] = [];
  sig.onMessage((m) => got.push(m));
  sock.emitMessage({ type: 'reclaimed', viewers: [{ peerId: 'p2', pseudo: 'joany' }], iceServers: [] });
  sock.emitMessage({ type: 'reclaim-error', reason: 'invalid' });
  assert.deepEqual(got, [
    { type: 'reclaimed', viewers: [{ peerId: 'p2', pseudo: 'joany' }], iceServers: [] },
    { type: 'reclaim-error', reason: 'invalid' },
  ]);
});

test('rien n est envoyé tant que le socket n est pas OPEN', () => {
  const sock = new FakeSocket(); // reste en CONNECTING
  const sig = new Signaling('ws://test', () => sock as unknown as WebSocket);
  sig.connect();
  sig.create();
  assert.equal(sock.sent.length, 0);
});

test('les messages non-JSON, non-string ou hors-schéma sont ignorés', async () => {
  const { sig, sock } = await connected();
  const got: unknown[] = [];
  sig.onMessage((m) => got.push(m));
  sock.emitRaw('pas du json{');
  sock.emitRaw(42);
  sock.emitRaw('null'); // JSON valide → null
  sock.emitRaw('123'); // JSON valide → nombre
  sock.emitRaw(JSON.stringify({ noType: true })); // objet sans `type`
  assert.equal(got.length, 0);
});

test('un handler qui jette ne prive pas les autres du message', async () => {
  const { sig, sock } = await connected();
  const got: string[] = [];
  sig.onMessage(() => {
    throw new Error('boom');
  });
  sig.onMessage((m) => got.push((m as { type: string }).type));
  const originalError = console.error;
  console.error = () => {}; // silence l'erreur attendue du handler fautif
  try {
    sock.emitMessage({ type: 'hello', peerId: 'p1' });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(got, ['hello']);
});

test('onMessage: le désabonnement stoppe la livraison', async () => {
  const { sig, sock } = await connected();
  const got: unknown[] = [];
  const off = sig.onMessage((m) => got.push(m));
  off();
  sock.emitMessage({ type: 'hello', peerId: 'p1' });
  assert.equal(got.length, 0);
});

test('un second connect() ferme le précédent et le nouveau socket fonctionne', async () => {
  const sockets: FakeSocket[] = [];
  const sig = new Signaling('ws://test', () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s as unknown as WebSocket;
  });
  const p1 = sig.connect();
  sockets[0].emitOpen();
  await p1;
  const p2 = sig.connect();
  sockets[1].emitOpen();
  await p2;
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, true, 'ancien socket fermé');
  assert.equal(sockets[1].closed, false, 'nouveau socket actif');
  // le nouveau socket dispatche réellement les messages
  const got: unknown[] = [];
  sig.onMessage((m) => got.push(m));
  sockets[1].emitMessage({ type: 'hello', peerId: 'p9' });
  assert.deepEqual(got, [{ type: 'hello', peerId: 'p9' }]);
});

// --- reconnexion ---

// Fabrique une Signaling avec des sockets traçables et un scheduler manuel (jobs[]).
const withReconnect = () => {
  const sockets: FakeSocket[] = [];
  const jobs: Array<() => void> = [];
  const sig = new Signaling(
    'ws://test',
    () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    (fn) => jobs.push(fn),
  );
  const statuses: string[] = [];
  sig.onStatus((s) => statuses.push(s));
  return { sig, sockets, jobs, statuses };
};

test('une coupure inattendue déclenche une reconnexion qui rétablit le socket', async () => {
  const { sig, sockets, jobs, statuses } = withReconnect();
  const p = sig.connect();
  sockets[0].emitOpen();
  await p;
  const got: unknown[] = [];
  sig.onMessage((m) => got.push(m)); // handler enregistré AVANT la coupure
  sockets[0].emitClose(); // coupure distante
  assert.deepEqual(statuses, ['open', 'reconnecting']);
  assert.equal(jobs.length, 1, 'une tentative planifiée');
  jobs[0](); // exécute la tentative → socket[1]
  sockets[1].emitOpen();
  assert.deepEqual(statuses, ['open', 'reconnecting', 'open']);
  // le nouveau socket dispatche, le handler a survécu au cycle
  sockets[1].emitMessage({ type: 'hello', peerId: 'p1' });
  assert.deepEqual(got, [{ type: 'hello', peerId: 'p1' }]);
});

test('close() manuel ne déclenche pas de reconnexion', async () => {
  const { sig, sockets, jobs, statuses } = withReconnect();
  const p = sig.connect();
  sockets[0].emitOpen();
  await p;
  sig.close();
  assert.deepEqual(statuses, ['open', 'closed']);
  assert.equal(jobs.length, 0);
});

test('la reconnexion abandonne après MAX tentatives', async () => {
  const { sig, sockets, jobs, statuses } = withReconnect();
  const p = sig.connect();
  sockets[0].emitOpen();
  await p;
  // À chaque échec on rejoue la tentative planifiée, qui ré-échoue immédiatement.
  sockets[0].emitClose();
  let guard = 0;
  while (jobs.length > 0 && guard++ < 20) {
    const job = jobs.shift()!;
    job();
    sockets[sockets.length - 1].emitClose(); // la nouvelle tentative échoue
  }
  assert.equal(statuses.filter((s) => s === 'reconnecting').length, 5, '5 tentatives max');
  assert.equal(statuses.at(-1), 'closed', 'abandon');
});

test('un connect() manuel après abandon redonne un budget de reconnexion', async () => {
  const { sig, sockets, jobs, statuses } = withReconnect();
  const p = sig.connect();
  sockets[0].emitOpen();
  await p;
  // épuise le budget
  sockets[0].emitClose();
  let guard = 0;
  while (jobs.length > 0 && guard++ < 20) {
    jobs.shift()!();
    sockets[sockets.length - 1].emitClose();
  }
  assert.equal(statuses.at(-1), 'closed');
  // relance manuelle → `retries` réinitialisé
  const p2 = sig.connect();
  sockets[sockets.length - 1].emitOpen();
  await p2;
  statuses.length = 0;
  sockets[sockets.length - 1].emitClose();
  assert.deepEqual(statuses, ['reconnecting'], 'reconnexion re-planifiée, pas abandon immédiat');
});

