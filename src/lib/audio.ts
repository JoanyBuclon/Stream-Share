// Mixes the host's system audio (from getDisplayMedia) and mic (getUserMedia) into a single
// outgoing track via WebAudio. Pass-through when only one source is active (no context needed).
// Both mono and stereo inputs are upmixed to stereo output to avoid WebRTC codec artifacts.

export class AudioMixer {
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;

  /** Outgoing audio track for the given system track + mic preference, or null if neither.
   *  Reuses an already-acquired mic (so a source change doesn't re-prompt); only (re)acquires
   *  when the mic goes off→on. Throws if the mic is requested but permission is denied. */
  async build(systemTrack: MediaStreamTrack | null, wantMic: boolean): Promise<MediaStreamTrack | null> {
    if (wantMic && !this.micStream) this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!wantMic && this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    // Rebuild the mixing graph from scratch each call; the mic stream itself persists.
    void this.ctx?.close();
    this.ctx = null;
    const micTrack = this.micStream?.getAudioTracks()[0] ?? null;
    const sources = [systemTrack, micTrack].filter((t): t is MediaStreamTrack => t !== null);
    if (sources.length === 0) return null;
    if (sources.length === 1) {
      // Single source: wrap in stereo mixer to avoid WebRTC codec issues with mono.
      return this.toStereo(sources[0]);
    }
    // Two sources → mix through stereo destination node.
    this.ctx = new AudioContext();
    const merger = this.ctx.createChannelMerger(2);
    const dest = this.ctx.createMediaStreamDestination();
    merger.connect(dest);
    for (const track of sources) {
      const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
      source.connect(merger);
    }
    return dest.stream.getAudioTracks()[0] ?? null;
  }

  private toStereo(track: MediaStreamTrack): MediaStreamTrack {
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    const merger = this.ctx.createChannelMerger(2);
    source.connect(merger);
    const dest = this.ctx.createMediaStreamDestination();
    merger.connect(dest);
    return dest.stream.getAudioTracks()[0] ?? track;
  }

  teardown(): void {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}
