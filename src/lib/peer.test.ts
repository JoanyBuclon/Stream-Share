import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Peer, type PeerCallbacks, type PeerSignal } from './peer.ts';

// Fake RTCPeerConnection : enregistre les appels, laisse le test déclencher les évènements.
// `failOnIce` permet de simuler un candidat ICE que addIceCandidate rejette (comme le vrai).
class FakePC {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  addedTracks: Array<{ track: unknown; stream: unknown }> = [];
  addedIce: RTCIceCandidateInit[] = [];
  offerOptions: RTCOfferOptions[] = [];
  failOnIce: ((c: RTCIceCandidateInit) => boolean) | null = null;
  gate: Promise<void> | null = null; // si posé, setRemoteDescription attend (simule un await en vol)
  offerGate: Promise<void> | null = null; // si posé, createOffer attend (simule un restart en vol)

  addTrack(track: unknown, stream: unknown) {
    this.addedTracks.push({ track, stream });
  }
  async createOffer(options?: RTCOfferOptions) {
    this.offerOptions.push(options ?? {});
    if (this.offerGate) await this.offerGate;
    return { type: 'offer', sdp: 'OFFER' } as RTCSessionDescriptionInit;
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'ANSWER' } as RTCSessionDescriptionInit;
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    if (this.gate) await this.gate;
    if (this.connectionState === 'closed') throw new Error('InvalidStateError'); // comme le vrai après close()
    this.remoteDescription = d;
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    if (this.failOnIce?.(c)) throw new Error('candidat ICE invalide');
    this.addedIce.push(c);
  }
  close() {
    this.connectionState = 'closed';
  }
  fireIce(candidate: unknown) {
    this.onicecandidate?.({ candidate });
  }
  fireState(s: RTCPeerConnectionState) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
  fireIceState(s: RTCIceConnectionState) {
    this.iceConnectionState = s;
    this.oniceconnectionstatechange?.();
  }
  fireTrack(streams: unknown[]) {
    this.ontrack?.({ streams });
  }
}

const makePeer = (pc: FakePC, cb: PeerCallbacks) => new Peer({}, cb, () => pc as unknown as RTCPeerConnection);

test('offer(): ajoute les pistes, pose l offre locale, émet le SDP', async () => {
  const pc = new FakePC();
  const signals: PeerSignal[] = [];
  const peer = makePeer(pc, { onSignal: (d) => signals.push(d) });
  const track = { kind: 'video' };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  await peer.offer(stream);
  assert.deepEqual(pc.addedTracks, [{ track, stream }]);
  assert.deepEqual(pc.localDescription, { type: 'offer', sdp: 'OFFER' });
  assert.deepEqual(signals, [{ sdp: { type: 'offer', sdp: 'OFFER' } }]);
});

test('accept(offre): pose la description distante, répond, émet la réponse', async () => {
  const pc = new FakePC();
  const signals: PeerSignal[] = [];
  await makePeer(pc, { onSignal: (d) => signals.push(d) }).accept({
    sdp: { type: 'offer', sdp: 'REMOTE_OFFER' },
  });
  assert.deepEqual(pc.remoteDescription, { type: 'offer', sdp: 'REMOTE_OFFER' });
  assert.deepEqual(signals, [{ sdp: { type: 'answer', sdp: 'ANSWER' } }]);
});

test('accept(réponse): pose la description distante, aucun signal en retour', async () => {
  const pc = new FakePC();
  const signals: PeerSignal[] = [];
  await makePeer(pc, { onSignal: (d) => signals.push(d) }).accept({
    sdp: { type: 'answer', sdp: 'REMOTE_ANSWER' },
  });
  assert.deepEqual(pc.remoteDescription, { type: 'answer', sdp: 'REMOTE_ANSWER' });
  assert.deepEqual(signals, []);
});

test('trickle ICE: bufferisé avant la description distante, flush dans l ordre ensuite', async () => {
  const pc = new FakePC();
  const peer = makePeer(pc, { onSignal: () => {} });
  await peer.accept({ ice: { candidate: 'a' } });
  await peer.accept({ ice: { candidate: 'b' } });
  assert.deepEqual(pc.addedIce, [], 'bufferisé avant setRemoteDescription');
  await peer.accept({ sdp: { type: 'answer', sdp: 'X' } });
  assert.deepEqual(pc.addedIce, [{ candidate: 'a' }, { candidate: 'b' }], 'flush dans l ordre');
  await peer.accept({ ice: { candidate: 'c' } });
  assert.deepEqual(
    pc.addedIce,
    [{ candidate: 'a' }, { candidate: 'b' }, { candidate: 'c' }],
    'ajout direct une fois la description distante posée',
  );
});

test('un candidat ICE qui jette est ignoré sans faire tomber les autres ni rejeter accept', async () => {
  const pc = new FakePC();
  pc.failOnIce = (c) => (c as { candidate?: string }).candidate === 'bad';
  const peer = makePeer(pc, { onSignal: () => {} });
  // bufferisés avant la description distante
  await peer.accept({ ice: { candidate: 'good1' } });
  await peer.accept({ ice: { candidate: 'bad' } });
  await peer.accept({ ice: { candidate: 'good2' } });
  await peer.accept({ sdp: { type: 'answer', sdp: 'X' } }); // ne doit pas rejeter
  assert.deepEqual(pc.addedIce, [{ candidate: 'good1' }, { candidate: 'good2' }], 'le mauvais candidat est avalé');
  // chemin direct (remoteReady) : idem, avalé sans rejeter
  await peer.accept({ ice: { candidate: 'bad' } });
  assert.deepEqual(pc.addedIce, [{ candidate: 'good1' }, { candidate: 'good2' }], 'inchangé');
});

test('accept() après close() est un no-op', async () => {
  const pc = new FakePC();
  const signals: PeerSignal[] = [];
  const peer = makePeer(pc, { onSignal: (d) => signals.push(d) });
  peer.close();
  await peer.accept({ sdp: { type: 'offer', sdp: 'X' } });
  assert.equal(pc.remoteDescription, null);
  assert.deepEqual(signals, []);
  assert.equal(pc.connectionState, 'closed');
});

test('offer() après close() est un no-op', async () => {
  const pc = new FakePC();
  const signals: PeerSignal[] = [];
  const peer = makePeer(pc, { onSignal: (d) => signals.push(d) });
  peer.close();
  await peer.offer({ getTracks: () => [{ kind: 'video' }] } as unknown as MediaStream);
  assert.deepEqual(pc.addedTracks, []);
  assert.deepEqual(signals, []);
});

test('close() pendant un accept() en vol ne provoque pas de rejet', async () => {
  const pc = new FakePC();
  let release!: () => void;
  pc.gate = new Promise<void>((r) => (release = r)); // setRemoteDescription reste en vol
  const peer = makePeer(pc, { onSignal: () => {} });
  const p = peer.accept({ sdp: { type: 'offer', sdp: 'X' } });
  peer.close(); // ferme pendant l'await → setRemoteDescription jettera InvalidStateError
  release();
  await assert.doesNotReject(p); // accept() avale le rejet dû au close
  assert.equal(pc.remoteDescription, null); // jamais posée
});

test('onicecandidate émet un signal ICE (toJSON), null en fin de gathering est ignoré', () => {
  const pc = new FakePC();
  const signals: PeerSignal[] = [];
  makePeer(pc, { onSignal: (d) => signals.push(d) });
  pc.fireIce({ toJSON: () => ({ candidate: 'cand' }) });
  pc.fireIce(null);
  assert.deepEqual(signals, [{ ice: { candidate: 'cand' } }]);
});

test('ontrack transmet le premier flux; onState transmet l état', () => {
  const pc = new FakePC();
  let stream: MediaStream | null = null;
  let state: RTCPeerConnectionState | null = null;
  const peer = makePeer(pc, {
    onSignal: () => {},
    onTrack: (s) => (stream = s),
    onState: (st) => (state = st),
  });
  const s = { id: 's1' } as unknown as MediaStream;
  pc.fireTrack([s]);
  assert.equal(stream, s);
  pc.fireTrack([]); // pas de flux → pas d'appel
  assert.equal(stream, s);
  pc.fireState('connected');
  assert.equal(state, 'connected');
  assert.equal(peer.connectionState, 'connected');
});

test('restartIce (host) émet une offre iceRestart', async () => {
  const pc = new FakePC();
  const signals: PeerSignal[] = [];
  const peer = makePeer(pc, { onSignal: (d) => signals.push(d) });
  await peer.offer({ getTracks: () => [] } as unknown as MediaStream); // devient offerer
  signals.length = 0;
  await peer.restartIce();
  assert.deepEqual(pc.offerOptions.at(-1), { iceRestart: true });
  assert.deepEqual(signals, [{ sdp: { type: 'offer', sdp: 'OFFER' } }]);
});

test('restartIce est ignoré côté viewer (jamais offerer)', async () => {
  const pc = new FakePC();
  const signals: PeerSignal[] = [];
  const peer = makePeer(pc, { onSignal: (d) => signals.push(d) });
  await peer.accept({ sdp: { type: 'offer', sdp: 'X' } }); // viewer
  signals.length = 0;
  await peer.restartIce();
  assert.deepEqual(signals, []);
});

test('onIceState est remonté; failed déclenche un ICE restart côté host', async () => {
  const pc = new FakePC();
  const signals: PeerSignal[] = [];
  const states: RTCIceConnectionState[] = [];
  const peer = makePeer(pc, { onSignal: (d) => signals.push(d), onIceState: (s) => states.push(s) });
  await peer.offer({ getTracks: () => [] } as unknown as MediaStream);
  signals.length = 0;
  pc.fireIceState('disconnected'); // se rétablit seul → pas de restart
  pc.fireIceState('failed'); // déclenche le restart (fire-and-forget)
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(states, ['disconnected', 'failed']);
  assert.deepEqual(pc.offerOptions.at(-1), { iceRestart: true });
  assert.equal(signals.length, 1);
});

test('restartIce après close() est un no-op', async () => {
  const pc = new FakePC();
  const signals: PeerSignal[] = [];
  const peer = makePeer(pc, { onSignal: (d) => signals.push(d) });
  await peer.offer({ getTracks: () => [] } as unknown as MediaStream);
  signals.length = 0;
  peer.close();
  await peer.restartIce();
  assert.deepEqual(signals, []);
});

test('restartIce ne se chevauche pas (un restart en vol bloque le second)', async () => {
  const pc = new FakePC();
  const signals: PeerSignal[] = [];
  const peer = makePeer(pc, { onSignal: (d) => signals.push(d) });
  await peer.offer({ getTracks: () => [] } as unknown as MediaStream);
  signals.length = 0;
  pc.offerOptions.length = 0;
  let release!: () => void;
  pc.offerGate = new Promise<void>((r) => (release = r)); // 1er restart bloqué sur createOffer
  const p1 = peer.restartIce();
  const p2 = peer.restartIce(); // ignoré : un restart est déjà en vol
  release();
  await Promise.all([p1, p2]);
  assert.equal(pc.offerOptions.length, 1, 'un seul createOffer malgré deux appels');
});

test('accept() gère une seconde offre (renégociation ICE restart côté viewer)', async () => {
  const pc = new FakePC();
  const signals: PeerSignal[] = [];
  const peer = makePeer(pc, { onSignal: (d) => signals.push(d) });
  await peer.accept({ sdp: { type: 'offer', sdp: 'OFFER1' } }); // 1re offre → réponse
  signals.length = 0;
  await peer.accept({ sdp: { type: 'offer', sdp: 'OFFER2' } }); // renégociation ICE restart
  assert.equal(pc.remoteDescription?.sdp, 'OFFER2');
  assert.deepEqual(signals, [{ sdp: { type: 'answer', sdp: 'ANSWER' } }]);
});
