// Mixes the host's system audio (from getDisplayMedia) and mic (getUserMedia) into a single
// outgoing track via WebAudio. Pass-through when only one source is active — no graph is built,
// and no context is created until a mix is actually needed. Unit-tested in audio.test.ts.

export class AudioMixer {
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private nodes: AudioNode[] = []; // graph of the current build — disconnected on the next one

  private readonly makeContext: () => AudioContext;
  private readonly getMic: () => Promise<MediaStream>;

  /** `makeContext` and `getMic` are injected only so the rebuild/disconnect logic and the mic
   *  acquisition are testable without WebAudio or a real device. Plain fields, not parameter
   *  properties: Node's type stripping cannot erase those. */
  constructor(
    makeContext: () => AudioContext = () => new AudioContext({ sampleRate: 48000 }),
    getMic: () => Promise<MediaStream> = () => navigator.mediaDevices.getUserMedia({ audio: true }),
  ) {
    this.makeContext = makeContext;
    this.getMic = getMic;
  }

  /** Outgoing audio track for the given system track + mic preference, or null if neither.
   *  Reuses an already-acquired mic (so a source change doesn't re-prompt); only (re)acquires
   *  when the mic goes off→on. Throws if the mic is requested but permission is denied. */
  async build(systemTrack: MediaStreamTrack | null, wantMic: boolean): Promise<MediaStreamTrack | null> {
    if (wantMic && !this.micStream) this.micStream = await this.getMic();
    if (!wantMic && this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    // Rebuild the graph each call, but NOT the context: `new AudioContext()` spins up a hardware
    // audio device, while the nodes below are cheap. Disconnecting is not optional — a leftover
    // MediaStreamSource stays connected to the previous destination and keeps pulling from its
    // track for nothing. The context itself lives until teardown().
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    const micTrack = this.micStream?.getAudioTracks()[0] ?? null;
    const sources = [systemTrack, micTrack].filter((t): t is MediaStreamTrack => t !== null);
    if (sources.length === 0) return null;
    if (sources.length === 1) return sources[0]; // single source → no mixing needed
    // Two sources → mix through one destination node. Connecting straight to the destination IS the
    // mix: WebAudio sums every input, and the node is stereo ('speakers', channelCount 2), so a mono
    // mic lands on both channels and stereo system audio passes through untouched.
    // ponytail: do NOT add a ChannelMergerNode here to "force stereo" (bfa81bc tried, reverted).
    // connect(merger) without an index targets input 0 = the LEFT channel only, and a merger
    // downmixes each input to mono on the way in — silent left-ear-only bug. Opus encodes mono
    // fine on its own; stereo is negotiated in the SDP instead (cf. tuneOpus in peer.ts).
    // Pinned to 48 kHz — Opus's native rate, and what the capture is constrained to. Left to its
    // default the context adopts the hardware rate (44.1 kHz on plenty of Windows setups), which
    // would resample 48→44.1 here and back to 48 in the encoder: two conversions, zero benefit.
    this.ctx ??= this.makeContext();
    const dest = this.ctx.createMediaStreamDestination();
    this.nodes.push(dest);
    for (const track of sources) {
      const src = this.ctx.createMediaStreamSource(new MediaStream([track]));
      src.connect(dest);
      this.nodes.push(src);
    }
    return dest.stream.getAudioTracks()[0] ?? null;
  }

  teardown(): void {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    void this.ctx?.close(); // the only place the context is closed — cf. build()
    this.ctx = null;
  }
}
