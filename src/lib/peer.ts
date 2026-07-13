// One RTCPeerConnection wrapper per remote peer (cf. docs/webrtc-media.md).
// Flux host-initiated : le host appelle offer(), le viewer répond via accept().
// Les ICE candidates reçus avant la description distante sont bufferisés (trickle).
// Injecte une factory RTCPeerConnection dans les tests.

export type PeerSignal = { sdp: RTCSessionDescriptionInit } | { ice: RTCIceCandidateInit };

export interface PeerCallbacks {
  /** SDP ou ICE à relayer au pair via la signaling. */
  onSignal: (data: PeerSignal) => void;
  /** Flux distant reçu (côté viewer). */
  onTrack?: (stream: MediaStream) => void;
  /** Changement d'état de la connexion. */
  onState?: (state: RTCPeerConnectionState) => void;
  /** Changement d'état ICE (transport) — l'app peut afficher « reconnexion… » / « impossible ». */
  onIceState?: (state: RTCIceConnectionState) => void;
}

export type PeerConnectionFactory = (config: RTCConfiguration) => RTCPeerConnection;

// Cap ICE restarts: on a permanently unreachable path (restrictive NAT, no TURN) the state
// recurs to 'failed' forever — without a cap the host would re-offer in an endless loop.
const MAX_ICE_RESTARTS = 5;

export class Peer {
  private readonly pc: RTCPeerConnection;
  private readonly cb: PeerCallbacks;
  private remoteReady = false;
  private closed = false;
  private isOfferer = false;
  private restarting = false;
  private iceRestarts = 0;
  private readonly pendingIce: RTCIceCandidateInit[] = [];
  private readonly senders = new Map<'video' | 'audio', RTCRtpSender>();

  constructor(
    config: RTCConfiguration,
    cb: PeerCallbacks,
    makeConnection: PeerConnectionFactory = (c) => new RTCPeerConnection(c),
  ) {
    this.cb = cb;
    const pc = makeConnection(config);
    this.pc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) this.cb.onSignal({ ice: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => this.cb.onState?.(pc.connectionState);
    pc.oniceconnectionstatechange = () => this.onIceChange();
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (stream) this.cb.onTrack?.(stream);
    };
  }

  /** Côté host : ajoute les pistes du flux et émet une offre. `maxBitrateKbps` (le plafond bitrate
   *  choisi par l'host) sert à relever le start/min-bitrate dans le SDP — la qualité monte vite au
   *  lieu de ramper depuis ~300 kbps. */
  async offer(stream: MediaStream, opts?: { maxBitrateKbps?: number }): Promise<void> {
    if (this.closed) return;
    this.isOfferer = true;
    try {
      // Un m-line send-only par kind dès l'offre (même si la source initiale n'a pas d'audio),
      // pour qu'un changement de source puisse hot-swap audio/vidéo via replaceTrack — sans
      // renégociation. Les senders sont mémorisés par kind pour replaceTracks().
      for (const kind of ['video', 'audio'] as const) {
        const track = stream.getTracks().find((t) => t.kind === kind);
        const transceiver = track
          ? this.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] })
          : this.pc.addTransceiver(kind, { direction: 'sendonly' });
        if (kind === 'video') preferVideoCodecs(transceiver); // VP9/AV1 avant VP8 (meilleure qualité/bit)
        this.senders.set(kind, transceiver.sender);
      }
      const offer = await this.pc.createOffer();
      if (opts?.maxBitrateKbps && offer.sdp) offer.sdp = tuneStartBitrate(offer.sdp, opts.maxBitrateKbps);
      await this.pc.setLocalDescription(offer);
      if (this.closed) return; // fermé pendant l'await : ne pas émettre vers un pair retiré
      this.emitLocalDescription();
    } catch (err) {
      if (!this.closed) throw err; // rejet réel, pas un close() en vol
    }
  }

  /** Échange les pistes sortantes (changement de source, reprise de pause) sans renégocier.
   *  Chaque m-line pré-négocié dans offer() reçoit la piste correspondante de la nouvelle
   *  source, ou `null` si ce kind en est absent (l'audio se retire proprement). */
  async replaceTracks(stream: MediaStream): Promise<void> {
    if (this.closed) return;
    try {
      for (const [kind, sender] of this.senders) {
        const next = stream.getTracks().find((t) => t.kind === kind) ?? null;
        if (sender.track !== next) await sender.replaceTrack(next);
      }
    } catch (err) {
      if (!this.closed) throw err; // close() en vol : avalé, comme offer()/accept()
    }
  }

  /** Règle les paramètres d'encodage du sender vidéo (débit max, downscale, dégradation) —
   *  sans renégociation. Appelé par l'host à chaque changement de qualité et pour chaque
   *  nouveau viewer. */
  async setVideoParameters(p: {
    maxBitrate?: number;
    scaleResolutionDownBy?: number;
    degradationPreference?: RTCDegradationPreference;
  }): Promise<void> {
    if (this.closed) return;
    const sender = this.senders.get('video');
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      if (p.maxBitrate !== undefined) params.encodings[0].maxBitrate = p.maxBitrate;
      if (p.scaleResolutionDownBy !== undefined) params.encodings[0].scaleResolutionDownBy = p.scaleResolutionDownBy;
      if (p.degradationPreference !== undefined) params.degradationPreference = p.degradationPreference;
      await sender.setParameters(params);
    } catch (err) {
      if (!this.closed) throw err;
    }
  }

  /** Relance la négociation ICE (côté host/offerer) après une coupure de transport.
   *  Émet une nouvelle offre `iceRestart` ; le viewer y répond via accept(). */
  async restartIce(): Promise<void> {
    if (this.closed || !this.isOfferer || this.restarting) return; // pas de restart chevauchant
    this.restarting = true;
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
      if (this.closed) return;
      this.emitLocalDescription();
    } catch (err) {
      if (!this.closed) throw err;
    } finally {
      this.restarting = false;
    }
  }

  /** Traite un signal entrant venu du pair (SDP ou ICE en trickle). */
  async accept(data: PeerSignal): Promise<void> {
    if (this.closed) return;
    try {
      if ('sdp' in data) {
        await this.pc.setRemoteDescription(data.sdp);
        this.remoteReady = true;
        for (const ice of this.pendingIce.splice(0)) await this.addIce(ice);
        if (data.sdp.type === 'offer') {
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          this.emitLocalDescription();
        }
      } else if (this.remoteReady) {
        await this.addIce(data.ice);
      } else {
        this.pendingIce.push(data.ice); // bufferisé jusqu'à setRemoteDescription
      }
    } catch (err) {
      // Un close() survenu pendant un await fait rejeter l'opération WebRTC :
      // on l'avale. Toute autre erreur (SDP invalide…) reste levée.
      if (!this.closed) throw err;
    }
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  /** Snapshot of the connection's WebRTC stats (viewer overlay). Null once closed. */
  async stats(): Promise<RTCStatsReport | null> {
    if (this.closed) return null;
    return this.pc.getStats();
  }

  close(): void {
    this.closed = true;
    this.pc.close();
  }

  /** Sur coupure de transport : remonte l'état ICE ; côté host, tente un ICE restart
   *  quand l'état passe à 'failed' ('disconnected' se rétablit souvent seul). */
  private onIceChange(): void {
    const state = this.pc.iceConnectionState;
    this.cb.onIceState?.(state);
    if (state === 'connected' || state === 'completed') this.iceRestarts = 0; // recovered → budget rendu
    if (state === 'failed' && this.iceRestarts < MAX_ICE_RESTARTS) {
      this.iceRestarts += 1;
      void this.restartIce().catch(() => {});
    }
  }

  /** Ajoute un candidat ICE en avalant les erreurs : un candidat invalide ne doit
   *  pas faire tomber la connexion ni les candidats suivants (non fatal en WebRTC). */
  private async addIce(ice: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(ice);
    } catch {
      // candidat ICE invalide : ignoré.
    }
  }

  private emitLocalDescription(): void {
    const sdp = this.pc.localDescription;
    if (sdp) this.cb.onSignal({ sdp });
  }
}

// VP9 puis AV1 avant VP8 : les deux ont un mode "screen content coding" et une bien meilleure
// qualité/bit sur du partage d'écran. VP9 en tête (pas AV1) — l'encodage AV1 logiciel temps réel
// peine en 4K60, VP9 est le compromis fiable ; réordonner ici pour changer. VP8 reste le fallback
// universel. Via l'API `setCodecPreferences` (pas de munging SDP → non rejeté par le navigateur).
const CODEC_PREFERENCE = ['video/VP9', 'video/AV1', 'video/VP8'];
function preferVideoCodecs(transceiver: RTCRtpTransceiver): void {
  if (!('setCodecPreferences' in transceiver) || typeof RTCRtpSender === 'undefined') return;
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps) return;
  const rank = (mimeType: string): number => {
    const i = CODEC_PREFERENCE.indexOf(mimeType);
    return i === -1 ? CODEC_PREFERENCE.length : i; // rtx/red/ulpfec et inconnus : après, ordre conservé (tri stable)
  };
  const ordered = [...caps.codecs].sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
  try {
    transceiver.setCodecPreferences(ordered);
  } catch {
    // ordre refusé par le navigateur (codec requis manquant…) — on garde l'ordre par défaut
  }
}

// ponytail: chemin Chrome/VPx uniquement. Les params `x-google-*` sont honorés par Chrome (VP8/VP9),
// ignorés par Firefox et par AV1 — ils relèvent le débit de départ/plancher sur le chemin dominant
// (Chrome+VP9) et sont un no-op inoffensif ailleurs. Ajoutés seulement aux codecs qui portent déjà
// une ligne fmtp (VP9/AV1 en ont toujours ; un VP8 nu sans fmtp est ignoré — passer par
// setParameters/maxBitrate suffit pour le plafond, ceci ne touche que start/min).
export function tuneStartBitrate(sdp: string, maxKbps: number): string {
  if (maxKbps <= 0) return sdp;
  const min = Math.max(300, Math.round(maxKbps * 0.4)); // plancher : pas d'effondrement sur un creux bref
  const start = Math.min(maxKbps, Math.round(maxKbps * 0.8)); // démarre haut au lieu de ramper depuis ~300k
  const extra = `x-google-start-bitrate=${start};x-google-min-bitrate=${min}`;
  const lines = sdp.split('\r\n');
  let inVideo = false;
  const videoPts = new Set<string>();
  for (const line of lines) {
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
    else if (inVideo) {
      const m = /^a=rtpmap:(\d+) (VP8|VP9|AV1)\//.exec(line);
      if (m) videoPts.add(m[1]);
    }
  }
  if (videoPts.size === 0) return sdp;
  return lines
    .map((line) => {
      const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
      return m && videoPts.has(m[1]) ? `a=fmtp:${m[1]} ${m[2]};${extra}` : line;
    })
    .join('\r\n');
}
