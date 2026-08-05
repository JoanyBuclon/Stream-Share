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
  /** Cap the capture rate; 0 means uncapped. Goes to the addon, which refuses frames before the
   *  tone map — the generated track rejects `applyConstraints` outright. */
  setFps(fps: number): void;
  /** Height of the frames actually arriving, or 0 before the first one. The generated track reports
   *  NO dimensions at all (getSettings() is {deviceId, resizeMode}), so this is the only source of
   *  truth the quality ladder has that does not depend on a <video> element having rendered. */
  height(): number;
  stop(): void;
}

/** Repeater period. Note it doubles as the staleness threshold, so the FIRST repeat lands up to
 *  2×IDLE_REPEAT_MS after the last real frame — the floor is 1-2 fps, not a flat 2. */
const IDLE_REPEAT_MS = 500;
/**
 * Consecutive repeats before we stop believing the capture is alive — deliberately far beyond any
 * plausible idle. `closed` is the real signal and it fires immediately; this is only the net for an
 * addon that stops producing while still claiming to be healthy.
 *
 * It started at 20 (10 s) and that was wrong in the dangerous direction. WGC delivers nothing at
 * all while nothing changes, and "nothing changes" is a real state: a full-screen document with no
 * caret and a still mouse can go minutes without a single frame — the taskbar clock only ticks once
 * a minute. A false positive here KILLS A WORKING SHARE; a slow true positive only delays a
 * teardown the user will trigger themselves. So the asymmetry decides the value.
 *
 * ponytail: a count of repeats is a proxy for "is the capture healthy", and the addon is the only
 * thing that can answer that properly. The upgrade is a real health signal from it (its own frame
 * counter against wall time), not a bigger number here.
 */
const MAX_REPEATS = 240; // 2 minutes at IDLE_REPEAT_MS
/** The port handover is synchronous inside `startNativeCapture`; this is 100x the margin. */
const PORT_TIMEOUT_MS = 3000;

/**
 * True when this build is running inside the shell AND native capture can actually run.
 *
 * The whole set, not just the entry point: an older installer paired with a newer web build has
 * `startNativeCapture` but no `setCaptureFps`, and would then capture in HDR while the fps slider
 * silently did nothing at all. Better to take the getDisplayMedia path than a half-driveable one.
 */
export function canCaptureNative(): boolean {
  const native = window.native;
  return (
    native?.canCaptureNative?.() === true &&
    typeof native.startNativeCapture === 'function' &&
    typeof native.setCaptureFps === 'function' &&
    typeof native.nativeCaptureStats === 'function'
  );
}

/**
 * Start native capture of `deviceName` and return it as a track.
 *
 * `sdrWhiteNits` comes from the source list; leaving it undefined means the addon falls back to the
 * scRGB definition (80), which on a real HDR desktop is wrong by whatever the user's SDR brightness
 * slider is set to — measured at 6x on the dev machine, and the difference between 0% and 70% of
 * the highlights clipping. Pass the measured value.
 */
export async function captureNative(
  deviceName: string,
  sdrWhiteNits?: number,
  fps?: number,
): Promise<NativeCapture> {
  const native = window.native;
  if (!native?.startNativeCapture) throw new Error('native capture unavailable');

  const Generator = (window as unknown as { MediaStreamTrackGenerator?: TrackGeneratorCtor }).MediaStreamTrackGenerator;
  if (!Generator) throw new Error('MediaStreamTrackGenerator unavailable');

  // Listener first, THEN start: the shell hands the port over synchronously inside
  // startNativeCapture, so registering afterwards would miss it every time.
  let handover: ReturnType<typeof setTimeout> | undefined;
  const port = await new Promise<MessagePort>((resolve, reject) => {
    // A timeout, because the alternative is not "we wait a bit longer" — it is a locked UI. The
    // picker sets `capturing` before calling this, which makes its close button a no-op and
    // swallows Escape, so a promise that never settles traps the user in a modal with no way out
    // but killing the app.
    handover = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      // The capture may well have started before the message went missing.
      window.native?.stopNativeCapture?.();
      reject(new Error('the shell never handed over the frame port'));
    }, PORT_TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      // Origin-checked: the handover carries the only handle to the frame stream, and anything else
      // on the page could otherwise claim it — seeing every frame and stranding us.
      if (event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null || (data as { streamShare?: string }).streamShare !== 'frames') return;
      const handed = event.ports[0];
      if (!handed) return;
      window.removeEventListener('message', onMessage);
      clearTimeout(handover);
      resolve(handed);
    };
    window.addEventListener('message', onMessage);
    try {
      // No knee: the shader default (0.75) is the only value anything has ever passed, and a
      // parameter with no caller is a knob to maintain for nobody. Add it back with its slider.
      native.startNativeCapture?.(deviceName, sdrWhiteNits, undefined, fps);
    } catch (err) {
      window.removeEventListener('message', onMessage);
      clearTimeout(handover);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  // The addon is CAPTURING from here on. Anything that throws below must stop it, or the WGC
  // session, its D3D device and the tone map run for the life of the window with no handle left to
  // reach them — while the caller quietly falls back to getDisplayMedia.
  let generator: MediaStreamTrack & { readonly writable: WritableStream<VideoFrame> };
  let writer: WritableStreamDefaultWriter<VideoFrame>;
  try {
    generator = new Generator({ kind: 'video' });
    writer = generator.writable.getWriter();
  } catch (err) {
    port.close();
    native.stopNativeCapture?.();
    throw err;
  }

  let dropped = 0;
  let writing = false;
  let stopped = false;
  // The most recent frame, kept alive for the repeater below. `clone()` shares the buffer, it does
  // not copy it — but it IS another reference to a hardware buffer, so exactly one is held.
  let last: VideoFrame | null = null;
  let lastWriteMs = 0;
  let lastSentUs = 0;
  let repeats = 0;
  let height = 0;

  /**
   * End the track in the way host.ts can HEAR — i.e. from the source side.
   *
   * `generator.stop()` does not do that: measured in this Chromium, it moves `readyState` to
   * `ended` and fires nothing, which is exactly what the spec says (`ended` is not fired when the
   * application itself calls stop()). Closing the writable is what ends the track *as a source*,
   * and that does fire it — 0.4 ms later, measured.
   *
   * The distinction is the whole point, so both callers stay honest:
   *   - the capture DIED (see the repeater) → notify, or the host keeps a frozen frame on screen;
   *   - we stopped it on purpose (see `stop()`) → stay silent, the host already knows. Firing there
   *     ran `stopSource()` inside `capture()`'s await on every source change away from HDR: the
   *     share un-paused itself and the per-app mutes were dropped.
   */
  const endTrack = (): void => void writer.close().catch(() => {});

  const send = (frame: VideoFrame): void => {
    writing = true;
    lastWriteMs = performance.now();
    // Read BEFORE the write hands ownership over. Tracked separately from `last.timestamp` because
    // `last` only changes when a real frame arrives: repeating off it produced the SAME timestamp
    // on every tick of an idle run, which an encoder is entitled to drop.
    lastSentUs = frame.timestamp;
    // The track closes the frame once written; a rejected write (track ended) does not, hence the
    // catch. Not awaited: this is an event handler, and the flag above is the backpressure.
    void writer
      .write(frame)
      .catch(() => frame.close())
      .finally(() => {
        writing = false;
      });
  };

  /**
   * Keep feeding the encoder while the screen is still.
   *
   * WGC only produces a frame when something CHANGES — an idle desktop measured 0.2 fps. That is a
   * feature for CPU, and a bug for viewers: WebRTC cannot answer a keyframe request with no input,
   * so someone joining while the host reads a document would wait for the first movement before
   * seeing anything at all. The getDisplayMedia path does not have this problem, so turning HDR on
   * must not introduce it.
   *
   * Cheap by construction: `new VideoFrame(last, …)` re-wraps the same buffer, and an unchanged
   * frame costs the encoder almost nothing to code.
   *
   * **And it must not outlive the capture.** WGC stopping is indistinguishable, from here, from a
   * screen that is merely still — so a repeater with no limit would keep a dead capture looking
   * perfectly alive: green stats, a "live" badge, and viewers staring at one frozen image. The
   * likeliest way to get there is the user pressing Win+Alt+B, which on an HDR feature is not an
   * exotic scenario. So: give up after MAX_REPEATS, or as soon as the addon reports the capture
   * item closed, and end the track — `ended` is what host.ts listens to for "the source is gone".
   *
   * MAX_REPEATS is the net for when the addon does NOT report it — see the constant for why it is
   * as long as it is, and why that branch is not the one doing the work.
   */
  const repeater = setInterval(() => {
    if (stopped) return;
    // The death check runs FIRST, and in particular before the `!last` guard below. A capture can
    // die before it ever produces a frame — HDR switched off between the pick and the first frame,
    // or a capture item that was already closed — and treating "no frame yet" as "nothing to do"
    // left the host on a black preview labelled `live` for ever, which is the exact failure the
    // rest of this comment is about. `closed` is terminal in the addon (set by
    // GraphicsCaptureItem::Closed, cleared only by Stop), so this can never kill a live capture.
    if (repeats >= MAX_REPEATS || window.native?.nativeCaptureStats?.()?.closed) {
      clearInterval(repeater);
      // NOT `stopped = true`: that is stop()'s own guard, and setting it here would make the
      // host's stop() — which is exactly what `ended` triggers — return before releasing the WGC
      // session and the port. Writes to the now-closed track simply reject, and send() closes
      // those frames.
      endTrack(); // `ended` is how the host learns the source died — see endTrack
      return;
    }
    if (writing || !last) return;
    if (performance.now() - lastWriteMs < IDLE_REPEAT_MS) return;
    repeats++;
    try {
      // A monotonically increasing timestamp, tracked separately from the source frame: the encoder
      // is entitled to discard a repeat that carries the same one, and `last` does not move.
      send(new VideoFrame(last, { timestamp: lastSentUs + IDLE_REPEAT_MS * 1000 }));
    } catch {
      /* the source frame was closed under us; the next real frame restarts the cycle */
    }
  }, IDLE_REPEAT_MS);

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
    height = frame.codedHeight;
    last?.close();
    last = frame.clone();
    repeats = 0; // a real frame means the capture is alive; the give-up counter starts over
    send(frame);
  };

  return {
    track: generator,
    droppedInPage: () => dropped,
    height: () => height,
    setFps: (value: number) => native.setCaptureFps?.(value),
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(repeater);
      last?.close();
      last = null;
      // Stop producing first, then let the port DRAIN. Closing it here instead would discard the
      // messages still queued on it, and each of those carries a transferred VideoFrame that would
      // then never be closed — the exact hardware-buffer leak this file exists to avoid. With
      // `stopped` set, the handler above closes every straggler.
      // ponytail: a macrotask is a heuristic, not a guarantee — nothing orders a setTimeout against
      // a MessagePort queue, and `stopNativeCapture()` on the line below closes the producer's end
      // synchronously, so this also assumes messages already posted survive their sender closing.
      // Both hold in practice and neither is specified or measured; a formal drain would need a
      // sentinel message from the preload, for a handful of frames at teardown.
      native.stopNativeCapture?.();
      setTimeout(() => port.close(), 0);
      // generator.stop(), NOT endTrack(): a deliberate stop must not fire `ended`. See endTrack.
      generator.stop();
      // The one frame that could otherwise slip through this file's rule that every frame is
      // either written or closed: a write in flight right now settles only if something settles
      // it, and releasing the lock rejects it — which runs send()'s catch, which closes it.
      writer.releaseLock();
    },
  };
}
