// The desktop shell's native HDR capture, as a MediaStreamTrack the peer connections can send.
//
// Frames are produced in the preload (see electron/src/preload.ts for why there and not in main)
// and arrive TRANSFERRED over a MessagePort — no copy at the boundary. Everything this file does is
// hand them to a MediaStreamTrackGenerator and make sure every one of them gets closed.
//
// Closing is not hygiene: a VideoFrame holds a hardware buffer, and unreleased ones wedge the
// renderer within about thirty frames. Every path here either writes a frame (the track takes
// ownership and closes it) or closes it explicitly — including the ones still in flight when the
// caller stops.

/** Chromium-only, no TS lib definition. `MediaStreamTrackGenerator` exists in this Chromium;
 *  `VideoTrackGenerator`, its announced worker-only replacement, does not. The whole native video
 *  output rests on it with no fallback — the day it goes, this file is what breaks. */
type TrackGeneratorCtor = new (init: { kind: 'video' }) => MediaStreamTrack & {
  readonly writable: WritableStream<VideoFrame>;
};

export interface NativeCapture {
  readonly track: MediaStreamTrack;
  /** Frames the page could not keep up with. Distinct from the addon's own `dropped` counter,
   *  which counts frames that never crossed. */
  droppedInPage(): number;
  stop(): void;
}

/** True when this build is running inside the shell AND native capture can actually run. */
export function canCaptureNative(): boolean {
  return window.native?.canCaptureNative?.() === true;
}

/**
 * Start native capture of `deviceName` and return it as a track.
 *
 * `sdrWhiteNits` comes from the source list; leaving it undefined means the addon falls back to the
 * scRGB definition (80), which on a real HDR desktop is wrong by whatever the user's SDR brightness
 * slider is set to — measured at 6x on the dev machine, and the difference between 0% and 70% of
 * the highlights clipping. Pass the measured value.
 */
export async function captureNative(deviceName: string, sdrWhiteNits?: number, knee?: number): Promise<NativeCapture> {
  const native = window.native;
  if (!native?.startNativeCapture) throw new Error('native capture unavailable');

  const Generator = (window as unknown as { MediaStreamTrackGenerator?: TrackGeneratorCtor }).MediaStreamTrackGenerator;
  if (!Generator) throw new Error('MediaStreamTrackGenerator unavailable');

  // Listener first, THEN start: the shell hands the port over synchronously inside
  // startNativeCapture, so registering afterwards would miss it every time.
  const port = await new Promise<MessagePort>((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      // Origin-checked: the handover carries the only handle to the frame stream, and anything else
      // on the page could otherwise claim it — seeing every frame and stranding us.
      if (event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null || (data as { streamShare?: string }).streamShare !== 'frames') return;
      const handed = event.ports[0];
      if (!handed) return;
      window.removeEventListener('message', onMessage);
      resolve(handed);
    };
    window.addEventListener('message', onMessage);
    try {
      native.startNativeCapture?.(deviceName, sdrWhiteNits, knee);
    } catch (err) {
      window.removeEventListener('message', onMessage);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  const generator = new Generator({ kind: 'video' });
  const writer = generator.writable.getWriter();

  let dropped = 0;
  let writing = false;
  let stopped = false;

  port.onmessage = (event: MessageEvent<VideoFrame>): void => {
    const frame = event.data;
    // Never queue. (Not "newest wins": the frame kept is the one already being written, i.e. the
    // older one — we refuse the arrival.) Awaiting each write while frames keep arriving would
    // build an unbounded backlog, which on a live stream is worse than a dropped frame: latency
    // grows without bound and never recovers.
    if (stopped || writing) {
      dropped++;
      frame.close();
      return;
    }
    writing = true;
    // The track closes the frame once written; a rejected write (track ended) does not, hence the
    // catch. Not awaited: this is an event handler, and the flag above is the backpressure.
    void writer
      .write(frame)
      .catch(() => frame.close())
      .finally(() => {
        writing = false;
      });
  };

  return {
    track: generator,
    droppedInPage: () => dropped,
    stop: () => {
      if (stopped) return;
      stopped = true;
      // Stop producing first, then let the port DRAIN. Closing it here instead would discard the
      // messages still queued on it, and each of those carries a transferred VideoFrame that would
      // then never be closed — the exact hardware-buffer leak this file exists to avoid. With
      // `stopped` set, the handler above closes every straggler; one turn later there are none.
      native.stopNativeCapture?.();
      setTimeout(() => port.close(), 0);
      void writer.close().catch(() => {});
      generator.stop();
    },
  };
}
