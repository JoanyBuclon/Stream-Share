// Preload half of tools/bridge-bench.cjs. Kept separate because a preload has to be a file path.
const { contextBridge } = require('electron');

const buffers = new Map();

contextBridge.exposeInMainWorld('bench', {
  /** Hand a fresh buffer of `size` to the page. This is the crossing we are pricing. */
  alloc: (size) => new Uint8Array(size),
  /** Same, but from a buffer the preload keeps alive — tells us whether the cost is the allocation
   *  or the crossing. */
  reuse: (size) => {
    let b = buffers.get(size);
    if (!b) buffers.set(size, (b = new Uint8Array(size)));
    return b;
  },
  /** The other direction: page → preload. */
  sink: (u8) => u8.byteLength,

  /**
   * The escape hatch from cloning: `window.postMessage` with a transfer list.
   *
   * contextBridge always structured-CLONES. postMessage structured-clones too, but it accepts
   * transferables — and with contextIsolation the preload's `window` is the page's window, so this
   * crosses the context boundary by moving the backing store instead of copying it.
   */
  blast: (size, count, kind) => {
    try {
      for (let i = 0; i < count; i++) {
        if (kind === 'frame') {
          // A VideoFrame is transferable. If this works, the addon's bytes become a track without
          // ever being copied for the crossing.
          const frame = new VideoFrame(new Uint8Array(size), {
            format: 'BGRA', codedWidth: 1920, codedHeight: 1080, timestamp: i * 16666,
          });
          window.postMessage({ bench: kind, i, frame }, '*', [frame]);
        } else {
          const buf = new ArrayBuffer(size);
          window.postMessage({ bench: kind, i, buf }, '*', [buf]);
        }
      }
      return { ok: true };
    } catch (err) {
      // Reported rather than thrown: a throw across contextBridge loses the message.
      return { ok: false, error: String(err) };
    }
  },

  /** Sustained, paced like a real 60 fps stream — one frame per tick, not a blast. The blast is
   *  what wedged the renderer, and a design validated only on single messages would ship that. */
  pace: (size, count, kind, everyMs, done) => {
    let i = 0;
    const timer = setInterval(() => {
      if (i >= count) {
        clearInterval(timer);
        done();
        return;
      }
      const t0 = performance.now();
      if (kind === 'frame') {
        const frame = new VideoFrame(new Uint8Array(size), {
          format: 'BGRA', codedWidth: 1920, codedHeight: 1080, timestamp: i * 16666,
        });
        window.postMessage({ bench: 'paced', i, sendMs: performance.now() - t0, frame }, '*', [frame]);
      } else {
        const buf = new ArrayBuffer(size);
        window.postMessage({ bench: 'paced', i, sendMs: performance.now() - t0, buf }, '*', [buf]);
      }
      i++;
    }, everyMs);
  },

  /** What the isolated world actually has, so a failure above can be told apart from an absence. */
  probe: () => ({
    VideoFrame: typeof VideoFrame,
    MediaStreamTrackGenerator: typeof MediaStreamTrackGenerator,
    postMessage: typeof window.postMessage,
  }),
});
