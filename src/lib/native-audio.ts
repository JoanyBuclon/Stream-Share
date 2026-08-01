// Desktop-only: turns the shell's raw PCM streams (the system mix minus one app, or one stream per
// app left audible) into a single MediaStreamTrack the AudioMixer treats like any other system
// track. See docs/desktop.md.
//
// No AudioWorklet. Each ~10 ms chunk is scheduled as its own AudioBufferSourceNode, which is both
// smaller and a better fit here: the addon DROPS silent buffers, so an underrun means "schedule
// nothing" instead of "synthesize silence", and the CSP (script-src 'self', no blob:) would have
// forced the worklet into a separate public/ asset that Vite doesn't bundle — untestable.

/** Chunk geometry, fixed in the addon's C++: 48 kHz, 16-bit, stereo, interleaved. */
const SAMPLE_RATE = 48000;
const CHANNELS = 2;

/** How far ahead of the clock playback is anchored. The calibration knob: too low and any IPC
 *  hiccup underruns, too high and viewers hear the audio lag the picture. 5 chunks. */
export const LEAD_SECONDS = 0.05;
/** Queue ceiling. Past this the machine handed us a burst, or the WASAPI and AudioContext clocks
 *  have drifted apart. */
export const MAX_LEAD_SECONDS = 0.4;

/**
 * Where the next chunk should start.
 *
 * Every silence gap re-anchors to `now + LEAD`, which is also what keeps the two clocks from
 * drifting apart over a long session: the addon's silence-dropping hands us a free resync several
 * times a minute.
 *
 * Running too far ahead re-anchors too, rather than dropping the chunk. Dropping leaves the cursor
 * where it was, so after one burst the audio would sit a full MAX_LEAD behind the picture
 * *permanently* — bounded, but bounded at the worst value. One 10 ms glitch beats lasting lip-sync
 * drift.
 */
export function nextStartTime(cursor: number, now: number): number {
  if (cursor < now + LEAD_SECONDS) return now + LEAD_SECONDS; // first chunk, or after a gap
  if (cursor - now > MAX_LEAD_SECONDS) return now + LEAD_SECONDS; // drifted/burst → resync
  return cursor; // already anchored: play back to back
}

/**
 * Where `key`'s next chunk goes, advancing its cursor by `seconds`.
 *
 * One cursor PER SOURCE. Muting two apps means the shell runs one WASAPI session per app still
 * audible, and those arrive interleaved on a single IPC channel — a shared cursor would let one
 * app's chunk push the other's schedule forward, so every second chunk would land in the past and
 * be re-anchored, i.e. a permanent stutter on both. They are independent streams; the mixing
 * happens in the audio graph, where all of them feed the same destination node.
 *
 * Stale keys are never pruned: a stopped app's cursor is left in the past, which is exactly the
 * "after a gap" case nextStartTime already re-anchors if that app ever comes back.
 */
export function advance(cursors: Map<string, number>, key: string, now: number, seconds: number): number {
  const at = nextStartTime(cursors.get(key) ?? 0, now);
  cursors.set(key, at + seconds);
  return at;
}

/** Interleaved little-endian Int16 → per-channel Float32 in [-1, 1). */
export function decodePcm(chunk: Uint8Array): Float32Array<ArrayBuffer>[] {
  const channels = CHANNELS;
  // Int16Array requires an even byteOffset and throws RangeError otherwise — inside an IPC
  // listener firing 100×/s, where nothing would catch it. Ours are always aligned; copying an odd
  // view is cheaper than being wrong about that.
  const src = chunk.byteOffset % 2 === 0 ? chunk : new Uint8Array(chunk);
  const samples = new Int16Array(src.buffer, src.byteOffset, Math.floor(src.byteLength / 2));
  const frames = Math.floor(samples.length / channels);
  // `new Float32Array(new ArrayBuffer(...))`, not `new Float32Array(n)`: the latter is typed
  // ArrayBufferLike, which copyToChannel (ArrayBuffer only) rejects since TS 5.7.
  const out = Array.from({ length: channels }, () => new Float32Array(new ArrayBuffer(frames * 4)));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) out[c][f] = samples[f * channels + c] / 32768;
  }
  return out;
}

export class NativeAudio {
  private ctx: AudioContext | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private readonly cursors = new Map<string, number>(); // per source: context time its next chunk plays at

  /** The track to hand the mixer, creating the graph on first use. */
  track(): MediaStreamTrack | null {
    if (!this.dest) {
      // Same 48 kHz as AudioMixer and as the capture — no resampling anywhere in the chain.
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      // Every path here starts from a click, so it should already be running. One line of
      // insurance: a suspended context leaves currentTime at 0, so every chunk piles up on the
      // same instant and the whole backlog fires at once when it resumes.
      void this.ctx.resume().catch(() => {});
      this.dest = this.ctx.createMediaStreamDestination();
    }
    return this.dest.stream.getAudioTracks()[0] ?? null;
  }

  /** Schedule one PCM chunk from source `key`. Cheap enough to call ~100×/s per live source; a
   *  dropped chunk is 10 ms. Every source connects to the same destination, so they sum. */
  push(key: string, chunk: Uint8Array): void {
    const ctx = this.ctx;
    const dest = this.dest;
    if (!ctx || !dest || chunk.byteLength < 4) return;
    const channels = decodePcm(chunk);
    const frames = channels[0].length;
    if (!frames) return;
    const at = advance(this.cursors, key, ctx.currentTime, frames / SAMPLE_RATE);
    const buffer = ctx.createBuffer(channels.length, frames, SAMPLE_RATE);
    for (let c = 0; c < channels.length; c++) buffer.copyToChannel(channels[c], c);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(dest);
    src.start(at);
  }

  teardown(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.dest = null;
    this.cursors.clear();
  }
}
