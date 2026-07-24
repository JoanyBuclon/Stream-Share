// One RTCPeerConnection wrapper per remote peer (cf. docs/webrtc-media.md).
// Host-initiated stream: the host calls offer(), the viewer responds via accept().
// ICE candidates received before the remote description are buffered (trickle).
// Inject an RTCPeerConnection factory in tests.

export type PeerSignal = { sdp: RTCSessionDescriptionInit } | { ice: RTCIceCandidateInit };

export interface PeerCallbacks {
  /** SDP or ICE to relay to the peer through the signaling channel. */
  onSignal: (data: PeerSignal) => void;
  /** Remote stream received (viewer side). */
  onTrack?: (stream: MediaStream) => void;
  /** Connection state change. */
  onState?: (state: RTCPeerConnectionState) => void;
  /** ICE (transport) state change — the app can show "reconnecting…" / "unreachable". */
  onIceState?: (state: RTCIceConnectionState) => void;
}

export type PeerConnectionFactory = (config: RTCConfiguration) => RTCPeerConnection;

// Cap ICE restarts: on a permanently unreachable path (restrictive NAT, no TURN) the state
// recurs to 'failed' forever — without a cap the host would re-offer in an endless loop.
const MAX_ICE_RESTARTS = 5;

// Cap buffered ICE candidates (those arriving before the remote SDP). A real negotiation trickles a
// handful; an unbounded buffer would let a peer that never sends an SDP grow it without limit.
const MAX_PENDING_ICE = 50;

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

  /** Host side: adds the stream's tracks and emits an offer. `maxBitrateKbps` (the bitrate cap
   *  chosen by the host) is used to raise the start/min-bitrate in the SDP — quality ramps up fast
   *  instead of crawling up from ~300 kbps. */
  async offer(stream: MediaStream, opts?: { maxBitrateKbps?: number }): Promise<void> {
    if (this.closed) return;
    this.isOfferer = true;
    try {
      // One send-only m-line per kind right from the offer (even if the initial source has no audio),
      // so that a source change can hot-swap audio/video via replaceTrack — without
      // renegotiation. Senders are memoized by kind for replaceTracks().
      for (const kind of ['video', 'audio'] as const) {
        const track = stream.getTracks().find((t) => t.kind === kind);
        // `streams: [stream]` MUST be passed even without a track. It is what puts an `a=msid` on
        // the m-line; without msid, the viewer does receive the track later (replaceTrack) but it
        // belongs to no stream — `ontrack` delivers `streams: []`, nothing is attached to the <video>,
        // and since replaceTrack does not renegotiate, the association NEVER happens. Permanent black
        // screen for anyone who joins during a pause (no video track in `outgoing`).
        const transceiver = this.pc.addTransceiver(track ?? kind, { direction: 'sendonly', streams: [stream] });
        if (kind === 'video') preferVideoCodecs(transceiver); // VP9/AV1 before VP8 (better quality/bit)
        this.senders.set(kind, transceiver.sender);
      }
      const offer = await this.pc.createOffer();
      if (opts?.maxBitrateKbps && offer.sdp) offer.sdp = tuneStartBitrate(offer.sdp, opts.maxBitrateKbps);
      await this.setLocalAndEmit(offer);
    } catch (err) {
      if (!this.closed) throw err; // real rejection, not a close() in flight
    }
  }

  /** Swaps the outgoing tracks (source change, resume from pause) without renegotiating.
   *  Each m-line pre-negotiated in offer() receives the matching track from the new
   *  source, or `null` if that kind is absent (audio is removed cleanly). */
  async replaceTracks(stream: MediaStream): Promise<void> {
    if (this.closed) return;
    try {
      for (const [kind, sender] of this.senders) {
        const next = stream.getTracks().find((t) => t.kind === kind) ?? null;
        if (sender.track !== next) await sender.replaceTrack(next);
      }
    } catch (err) {
      if (!this.closed) throw err; // close() in flight: swallowed, like offer()/accept()
    }
  }

  /** Sets the video sender's encoding parameters (max bitrate, downscale, degradation) —
   *  without renegotiation. Called by the host on every quality change and for each
   *  new viewer. */
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

  /** Restarts ICE negotiation (host/offerer side) after a transport drop.
   *  Emits a new `iceRestart` offer; the viewer responds to it via accept(). */
  async restartIce(): Promise<void> {
    if (this.closed || !this.isOfferer || this.restarting) return; // no overlapping restart
    this.restarting = true;
    try {
      await this.setLocalAndEmit(await this.pc.createOffer({ iceRestart: true }));
    } catch (err) {
      if (!this.closed) throw err;
    } finally {
      this.restarting = false;
    }
  }

  /** Handles an incoming signal from the peer (SDP or trickled ICE). */
  async accept(data: PeerSignal): Promise<void> {
    if (this.closed) return;
    try {
      if ('sdp' in data) {
        await this.pc.setRemoteDescription(data.sdp);
        this.remoteReady = true;
        for (const ice of this.pendingIce.splice(0)) await this.addIce(ice);
        if (data.sdp.type === 'offer') await this.setLocalAndEmit(await this.pc.createAnswer());
      } else if (this.remoteReady) {
        await this.addIce(data.ice);
      } else if (this.pendingIce.length < MAX_PENDING_ICE) {
        this.pendingIce.push(data.ice); // buffered until setRemoteDescription (bounded)
      }
    } catch (err) {
      // A close() happening during an await causes the WebRTC operation to reject:
      // we swallow it. Any other error (invalid SDP…) is still thrown.
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

  /** On transport drop: surfaces the ICE state; on the host side, attempts an ICE restart
   *  when the state turns to 'failed' ('disconnected' often recovers on its own). */
  private onIceChange(): void {
    const state = this.pc.iceConnectionState;
    this.cb.onIceState?.(state);
    if (state === 'connected' || state === 'completed') this.iceRestarts = 0; // recovered → budget refunded
    if (state === 'failed' && this.iceRestarts < MAX_ICE_RESTARTS) {
      this.iceRestarts += 1;
      void this.restartIce().catch(() => {});
    }
  }

  /** Adds an ICE candidate while swallowing errors: an invalid candidate must not
   *  take down the connection nor the following candidates (non-fatal in WebRTC). */
  private async addIce(ice: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(ice);
    } catch {
      // invalid ICE candidate: ignored.
    }
  }

  /** Sets the local description then emits it. Single path through which offer, answer and
   *  ICE restart offer all pass — Opus tuning must apply to each of them (cf. tuneOpus). */
  private async setLocalAndEmit(desc: RTCSessionDescriptionInit): Promise<void> {
    if (desc.sdp) desc.sdp = tuneOpus(desc.sdp);
    await this.pc.setLocalDescription(desc);
    if (this.closed) return; // closed during the await: do not emit to a removed peer
    this.emitLocalDescription();
  }

  private emitLocalDescription(): void {
    const sdp = this.pc.localDescription;
    if (sdp) this.cb.onSignal({ sdp });
  }
}

// VP9 then AV1 before VP8: both have a "screen content coding" mode and a much better
// quality/bit on screen sharing. VP9 first (not AV1) — real-time software AV1 encoding
// struggles at 4K60, VP9 is the reliable compromise; reorder here to change it. VP8 stays the
// universal fallback. Via the `setCodecPreferences` API (no SDP munging → not rejected by the browser).
const CODEC_PREFERENCE = ['video/VP9', 'video/AV1', 'video/VP8'];
function preferVideoCodecs(transceiver: RTCRtpTransceiver): void {
  if (!('setCodecPreferences' in transceiver) || typeof RTCRtpSender === 'undefined') return;
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps) return;
  const rank = (mimeType: string): number => {
    const i = CODEC_PREFERENCE.indexOf(mimeType);
    return i === -1 ? CODEC_PREFERENCE.length : i; // rtx/red/ulpfec and unknowns: after, order preserved (stable sort)
  };
  const ordered = [...caps.codecs].sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
  try {
    transceiver.setCodecPreferences(ordered);
  } catch {
    // order rejected by the browser (missing required codec…) — we keep the default order
  }
}

// WebRTC negotiates Opus for voice by default: mono, ~32 kbps. Fine for a mic, it butchers
// tab/system audio (music, games) — the sound "broken, like mono". An Opus encoder follows
// the REMOTE description, so each side tunes its own local SDP: `stereo=1` tells the peer
// "encode stereo for me", `sprop-stereo=1` announces what we send, `maxaveragebitrate` raises the
// ceiling. These params are standard (RFC 7587) — honored by Chrome, Firefox and Safari.
// ponytail: 128 kbps stereo hardcoded — transparent for music, negligible next to the video;
// wire it to the quality presets if a host complains about upload.
const OPUS_PARAMS: Record<string, string> = {
  stereo: '1',
  'sprop-stereo': '1',
  maxaveragebitrate: '128000',
  useinbandfec: '1',
};

export function tuneOpus(sdp: string): string {
  const lines = sdp.split('\r\n');
  let inAudio = false;
  const opusPts = new Set<string>();
  const withFmtp = new Set<string>();
  for (const line of lines) {
    if (line.startsWith('m=')) inAudio = line.startsWith('m=audio');
    else if (inAudio) {
      const rtpmap = /^a=rtpmap:(\d+) opus\//i.exec(line);
      if (rtpmap) opusPts.add(rtpmap[1]);
      const fmtp = /^a=fmtp:(\d+) /.exec(line);
      if (fmtp) withFmtp.add(fmtp[1]);
    }
  }
  if (opusPts.size === 0) return sdp;
  return lines
    .flatMap((line) => {
      const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
      if (fmtp && opusPts.has(fmtp[1])) return [`a=fmtp:${fmtp[1]} ${mergeOpusParams(fmtp[2])}`];
      const rtpmap = /^a=rtpmap:(\d+) opus\//i.exec(line);
      // Opus payload without an fmtp line (rare): one is needed, otherwise the params land nowhere.
      if (rtpmap && !withFmtp.has(rtpmap[1])) return [line, `a=fmtp:${rtpmap[1]} ${mergeOpusParams('')}`];
      return [line];
    })
    .join('\r\n');
}

// Merges into the existing params rather than concatenating: Firefox already emits `stereo=1`, and an
// fmtp that repeats a key is ambiguous. Ours overwrite, the rest (minptime…) is preserved.
function mergeOpusParams(existing: string): string {
  const params = new Map<string, string>();
  for (const kv of existing.split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) params.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
  }
  for (const [key, value] of Object.entries(OPUS_PARAMS)) params.set(key, value);
  return [...params].map(([key, value]) => `${key}=${value}`).join(';');
}

// ponytail: Chrome/VPx path only. The `x-google-*` params are honored by Chrome (VP8/VP9),
// ignored by Firefox and by AV1 — they raise the start/floor bitrate on the dominant path
// (Chrome+VP9) and are a harmless no-op elsewhere. Added only to codecs that already carry
// an fmtp line (VP9/AV1 always have one; a bare VP8 without fmtp is skipped — going through
// setParameters/maxBitrate is enough for the ceiling, this only touches start/min).
export function tuneStartBitrate(sdp: string, maxKbps: number): string {
  if (maxKbps <= 0) return sdp;
  const min = Math.max(300, Math.round(maxKbps * 0.4)); // floor: no collapse on a brief dip
  const start = Math.min(maxKbps, Math.round(maxKbps * 0.8)); // starts high instead of crawling up from ~300k
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
