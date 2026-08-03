import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Peer, tuneOpus, tuneStartBitrate, orderCodecs, type PeerCallbacks, type PeerSignal } from './peer.ts';

// Fake RTCPeerConnection : enregistre les appels, laisse le test déclencher les évènements.
// `failOnIce` permet de simuler un candidat ICE que addIceCandidate rejette (comme le vrai).
class FakePC {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  addedTracks: Array<{ track: unknown; stream: unknown }> = [];
  transceivers: Array<{
    kind: string;
    sender: {
      track: { kind: string } | null;
      params: { encodings: Record<string, number>[]; degradationPreference?: string };
      replaceTrack: (t: { kind: string } | null) => Promise<void>;
      getParameters: () => { encodings: Record<string, number>[]; degradationPreference?: string };
      setParameters: (p: { encodings: Record<string, number>[]; degradationPreference?: string }) => Promise<void>;
    };
  }> = [];
  addedIce: RTCIceCandidateInit[] = [];
  offerOptions: RTCOfferOptions[] = [];
  failOnIce: ((c: RTCIceCandidateInit) => boolean) | null = null;
  gate: Promise<void> | null = null; // si posé, setRemoteDescription attend (simule un await en vol)
  offerGate: Promise<void> | null = null; // si posé, createOffer attend (simule un restart en vol)

  addTransceiver(trackOrKind: unknown, init?: { direction?: string; streams?: unknown[] }) {
    const track = typeof trackOrKind === 'object' && trackOrKind !== null ? (trackOrKind as { kind: string }) : null;
    const kind = track ? track.kind : (trackOrKind as string);
    if (track) this.addedTracks.push({ track, stream: init?.streams?.[0] });
    const sender = {
      track,
      params: { encodings: [{}] } as { encodings: Record<string, number>[]; degradationPreference?: string },
      replaceTrack: async (t: { kind: string } | null) => {
        sender.track = t;
      },
      getParameters() {
        return sender.params;
      },
      async setParameters(p: { encodings: Record<string, number>[]; degradationPreference?: string }) {
        sender.params = p;
      },
    };
    this.transceivers.push({ kind, sender });
    return { sender };
  }
  getSenders() {
    return this.transceivers.map((t) => t.sender);
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
  async getStats() {
    return new Map([['id', { type: 'inbound-rtp', kind: 'video', bytesReceived: 1 }]]) as unknown as RTCStatsReport;
  }
  close() {
    this.connectionState = 'closed';
  }
  fireIce(candidate: unknown) {
    this.onicecandidate?.({ candidate });
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

test('offer: pré-négocie un m-line send-only par kind (video + audio)', async () => {
  const pc = new FakePC();
  const peer = makePeer(pc, { onSignal: () => {} });
  await peer.offer({ getTracks: () => [{ kind: 'video' }] } as unknown as MediaStream); // source vidéo seule
  assert.deepEqual(
    pc.transceivers.map((t) => t.kind),
    ['video', 'audio'],
    'un transceiver par kind même sans piste audio',
  );
});

test('replaceTracks: échange la piste sur le sender du même kind (changement de source)', async () => {
  const pc = new FakePC();
  const peer = makePeer(pc, { onSignal: () => {} });
  const v1 = { kind: 'video' };
  await peer.offer({ getTracks: () => [v1] } as unknown as MediaStream);
  assert.equal(pc.getSenders()[0].track, v1);
  const v2 = { kind: 'video' };
  await peer.replaceTracks({ getTracks: () => [v2] } as unknown as MediaStream);
  assert.equal(pc.getSenders()[0].track, v2, 'la piste vidéo est remplacée, sans renégociation');
});

test('replaceTracks: ajoute l audio via le m-line pré-négocié quand la source initiale n en avait pas', async () => {
  const pc = new FakePC();
  const peer = makePeer(pc, { onSignal: () => {} });
  await peer.offer({ getTracks: () => [{ kind: 'video' }] } as unknown as MediaStream); // vidéo seule
  const audio = { kind: 'audio' };
  await peer.replaceTracks({ getTracks: () => [{ kind: 'video' }, audio] } as unknown as MediaStream);
  const audioSender = pc.transceivers.find((t) => t.kind === 'audio');
  assert.equal(audioSender?.sender.track, audio, 'audio posé sur le sender pré-négocié (pas de perte silencieuse)');
});

test('replaceTracks: retire l audio absent de la nouvelle source (replaceTrack(null))', async () => {
  const pc = new FakePC();
  const peer = makePeer(pc, { onSignal: () => {} });
  const audio = { kind: 'audio' };
  await peer.offer({ getTracks: () => [{ kind: 'video' }, audio] } as unknown as MediaStream);
  await peer.replaceTracks({ getTracks: () => [{ kind: 'video' }] } as unknown as MediaStream); // plus d'audio
  const audioSender = pc.transceivers.find((t) => t.kind === 'audio');
  assert.equal(audioSender?.sender.track, null, 'le sender audio est vidé, pas laissé sur une piste morte');
});

test('replaceTracks après close() est un no-op', async () => {
  const pc = new FakePC();
  const peer = makePeer(pc, { onSignal: () => {} });
  const v1 = { kind: 'video' };
  await peer.offer({ getTracks: () => [v1] } as unknown as MediaStream);
  peer.close();
  await peer.replaceTracks({ getTracks: () => [{ kind: 'video' }] } as unknown as MediaStream);
  assert.equal(pc.getSenders()[0].track, v1, 'inchangé après close');
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

test('ontrack transmet le premier flux', () => {
  const pc = new FakePC();
  let stream: MediaStream | null = null;
  makePeer(pc, {
    onSignal: () => {},
    onTrack: (s) => (stream = s),
  });
  const s = { id: 's1' } as unknown as MediaStream;
  pc.fireTrack([s]);
  assert.equal(stream, s);
  pc.fireTrack([]); // pas de flux → pas d'appel
  assert.equal(stream, s);
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

test('setVideoParameters applique bitrate + scale + degradation sur le sender vidéo', async () => {
  const pc = new FakePC();
  const peer = makePeer(pc, { onSignal: () => {} });
  await peer.offer({ getTracks: () => [{ kind: 'video' }] } as unknown as MediaStream);
  await peer.setVideoParameters({ maxBitrate: 5_000_000, scaleResolutionDownBy: 1.5, degradationPreference: 'maintain-framerate' });
  const video = pc.transceivers.find((t) => t.kind === 'video')!;
  assert.equal(video.sender.params.encodings[0].maxBitrate, 5_000_000);
  assert.equal(video.sender.params.encodings[0].scaleResolutionDownBy, 1.5);
  assert.equal(video.sender.params.degradationPreference, 'maintain-framerate');
});

test('setVideoParameters après close() est un no-op', async () => {
  const pc = new FakePC();
  const peer = makePeer(pc, { onSignal: () => {} });
  await peer.offer({ getTracks: () => [{ kind: 'video' }] } as unknown as MediaStream);
  peer.close();
  await peer.setVideoParameters({ maxBitrate: 9_000_000 });
  const video = pc.transceivers.find((t) => t.kind === 'video')!;
  assert.equal(video.sender.params.encodings[0].maxBitrate, undefined, 'inchangé après close');
});

test('les ICE restarts sont plafonnés (pas de boucle infinie sur échec permanent)', async () => {
  const pc = new FakePC();
  const peer = makePeer(pc, { onSignal: () => {} });
  await peer.offer({ getTracks: () => [] } as unknown as MediaStream); // devient offerer
  pc.offerOptions.length = 0;
  for (let i = 0; i < 8; i++) {
    pc.fireIceState('failed');
    await new Promise((r) => setTimeout(r, 0)); // laisse le restart (fire-and-forget) se terminer
  }
  const restarts = pc.offerOptions.filter((o) => o.iceRestart).length;
  assert.equal(restarts, 5, 'plafonné à 5 restarts malgré 8 échecs');
});

test('stats() renvoie le rapport, null après close()', async () => {
  const pc = new FakePC();
  const peer = makePeer(pc, { onSignal: () => {} });
  const report = await peer.stats();
  assert.equal(report && [...report.values()].length, 1);
  peer.close();
  assert.equal(await peer.stats(), null);
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

test('tuneStartBitrate ajoute start/min aux fmtp vidéo (VP9/AV1), épargne audio et rtx', () => {
  const sdp = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10',
    'm=video 9 UDP/TLS/RTP/SAVPF 98 45 99',
    'a=rtpmap:98 VP9/90000',
    'a=fmtp:98 profile-id=0',
    'a=rtpmap:45 AV1/90000',
    'a=fmtp:45 level-idx=5;profile=0',
    'a=rtpmap:99 rtx/90000', // pas de fmtp → intouché
  ].join('\r\n');
  const out = tuneStartBitrate(sdp, 10_000); // start=8000
  assert.match(out, /a=fmtp:98 profile-id=0;x-google-start-bitrate=8000/);
  assert.match(out, /a=fmtp:45 level-idx=5;profile=0;x-google-start-bitrate=8000/);
  assert.match(out, /a=fmtp:111 minptime=10\r\n/); // audio inchangé
  assert.doesNotMatch(out, /rtx.*x-google/s); // rtx sans fmtp non touché
  // Le plancher a été retiré volontairement : il ne recule pas sous congestion, et il est devenu
  // atteignable le jour où un encodeur matériel a pu le produire. Cf. le commentaire sur la fonction.
  assert.doesNotMatch(out, /x-google-min-bitrate/);
});

test('tuneStartBitrate est un no-op sans section vidéo ou sans bitrate', () => {
  assert.equal(tuneStartBitrate('m=audio 9 RTP\r\na=rtpmap:111 opus/48000/2', 10_000), 'm=audio 9 RTP\r\na=rtpmap:111 opus/48000/2');
  assert.equal(tuneStartBitrate('m=video 9 RTP\r\na=rtpmap:98 VP9/90000', 0), 'm=video 9 RTP\r\na=rtpmap:98 VP9/90000');
});

// H.265 est devenu le codec préféré : si le hack cessait de s'y appliquer, le chemin dominant
// perdrait son démarrage haut sans que rien ne le signale.
test('tuneStartBitrate couvre aussi H265 et H264', () => {
  const sdp = [
    'm=video 9 UDP/TLS/RTP/SAVPF 49 102',
    'a=rtpmap:49 H265/90000',
    'a=fmtp:49 level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST',
    'a=rtpmap:102 H264/90000',
    'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  ].join('\r\n');
  const out = tuneStartBitrate(sdp, 10_000);
  assert.match(out, /a=fmtp:49 level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST;x-google-start-bitrate=8000/);
  assert.match(out, /a=fmtp:102 .*profile-level-id=42e01f;x-google-start-bitrate=8000/);
});

// EXTRAIT de la liste mesurée sur Chrome 151 / Windows — un représentant par codec, dans l ordre
// où Chrome les annonce. Ce n est PAS la liste complète (Chrome offre 8 variantes H.264, 4 profils
// VP9, 2 profils H.265) : elle suffit à exercer le classement, et l honnêteté sur ce point compte
// parce que l ordre des profils, lui, n est pas décidé ici (cf. docs/webrtc-media.md § Codec).
const CHROME_CODECS: RTCRtpCodec[] = [
  { mimeType: 'video/VP8', clockRate: 90000 },
  { mimeType: 'video/rtx', clockRate: 90000 },
  { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
  { mimeType: 'video/AV1', clockRate: 90000, sdpFmtpLine: 'level-idx=5;profile=0;tier=0' },
  { mimeType: 'video/H265', clockRate: 90000, sdpFmtpLine: 'level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST' },
  { mimeType: 'video/red', clockRate: 90000 },
  { mimeType: 'video/ulpfec', clockRate: 90000 },
];

test('orderCodecs: H265 en tête, puis VP9, AV1, H264, VP8 ; le reste après, dans l ordre', () => {
  const out = orderCodecs(CHROME_CODECS).map((c) => c.mimeType);
  assert.deepEqual(out, [
    'video/H265',
    'video/VP9',
    'video/AV1',
    'video/H264',
    'video/VP8',
    // rtx/red/ulpfec après, dans leur ordre d origine. La régression que ça attrape : un rank()
    // qui renverrait -1 au lieu de length pour l inconnu les mettrait EN TÊTE de la préférence.
    'video/rtx',
    'video/red',
    'video/ulpfec',
  ]);
});

// La garantie de non-régression du changement de codecs : Firefox n offre pas H.265 (vérifié sur
// 153, prefs forcés compris), il doit donc atterrir sur VP9 exactement comme aujourd hui.
test('orderCodecs: un viewer sans H265 (Firefox) reste sur VP9', () => {
  const firefox: RTCRtpCodec[] = [
    { mimeType: 'video/VP8', clockRate: 90000 },
    { mimeType: 'video/rtx', clockRate: 90000 },
    { mimeType: 'video/VP9', clockRate: 90000 },
    { mimeType: 'video/AV1', clockRate: 90000 },
  ];
  assert.deepEqual(orderCodecs(firefox).map((c) => c.mimeType), ['video/VP9', 'video/AV1', 'video/VP8', 'video/rtx']);
});

test('tuneOpus force stéréo + bitrate sur les fmtp opus, épargne la vidéo', () => {
  const sdp = [
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 98',
    'a=rtpmap:98 VP9/90000',
    'a=fmtp:98 profile-id=0',
  ].join('\r\n');
  const out = tuneOpus(sdp);
  assert.match(out, /a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000\r\n/);
  assert.match(out, /a=fmtp:98 profile-id=0/); // vidéo intouchée
});

test('tuneOpus ne duplique pas une clé déjà posée (SDP Firefox) et ajoute un fmtp manquant', () => {
  const firefox = 'm=audio 9 RTP\r\na=rtpmap:109 opus/48000/2\r\na=fmtp:109 stereo=0;useinbandfec=1';
  assert.match(tuneOpus(firefox), /a=fmtp:109 stereo=1;useinbandfec=1;sprop-stereo=1;maxaveragebitrate=128000$/);
  const noFmtp = 'm=audio 9 RTP\r\na=rtpmap:111 opus/48000/2';
  assert.match(tuneOpus(noFmtp), /a=rtpmap:111 opus\/48000\/2\r\na=fmtp:111 stereo=1;sprop-stereo=1;/);
  assert.equal(tuneOpus('m=video 9 RTP\r\na=rtpmap:98 VP9/90000'), 'm=video 9 RTP\r\na=rtpmap:98 VP9/90000'); // no-op
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
