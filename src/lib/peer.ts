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

export class Peer {
  private readonly pc: RTCPeerConnection;
  private readonly cb: PeerCallbacks;
  private remoteReady = false;
  private closed = false;
  private isOfferer = false;
  private restarting = false;
  private readonly pendingIce: RTCIceCandidateInit[] = [];

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

  /** Côté host : ajoute les pistes du flux et émet une offre. */
  async offer(stream: MediaStream): Promise<void> {
    if (this.closed) return;
    this.isOfferer = true;
    try {
      for (const track of stream.getTracks()) this.pc.addTrack(track, stream);
      await this.pc.setLocalDescription(await this.pc.createOffer());
      this.emitLocalDescription();
    } catch (err) {
      if (!this.closed) throw err; // rejet réel, pas un close() en vol
    }
  }

  /** Relance la négociation ICE (côté host/offerer) après une coupure de transport.
   *  Émet une nouvelle offre `iceRestart` ; le viewer y répond via accept(). */
  async restartIce(): Promise<void> {
    if (this.closed || !this.isOfferer || this.restarting) return; // pas de restart chevauchant
    this.restarting = true;
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
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

  close(): void {
    this.closed = true;
    this.pc.close();
  }

  /** Sur coupure de transport : remonte l'état ICE ; côté host, tente un ICE restart
   *  quand l'état passe à 'failed' ('disconnected' se rétablit souvent seul). */
  private onIceChange(): void {
    const state = this.pc.iceConnectionState;
    this.cb.onIceState?.(state);
    if (state === 'failed') void this.restartIce().catch(() => {});
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
