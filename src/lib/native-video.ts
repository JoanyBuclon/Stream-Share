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
  /** Frames this module currently owns and has neither written nor closed. The leak counter: from
   *  outside it can only ever read 1 (the repeater's clone) or 0 (after `stop()`) — every path that
   *  briefly holds two runs to completion without yielding. A number that climbs is a
   *  hardware-buffer leak, and ~30 of them wedges the renderer. */
  heldFrames(): number;
  /** Cap the capture rate; 0 means uncapped. Goes to the addon, which refuses frames before the
   *  tone map — the generated track rejects `applyConstraints` outright. */
  setFps(fps: number): void;
  /** Change the tone map's divisor without restarting anything. See `setSdrWhite` in global.d.ts
   *  for why it exists and why a still screen does not update immediately. */
  setSdrWhite(nits: number): void;
  /** Height of the frames actually arriving, or 0 before the first one.
   *
   *  The generated track cannot answer this when it matters: `getSettings()` is
   *  `{deviceId, resizeMode}` until frames have been written to it (measured at creation), and only
   *  then picks up width/height/frameRate (measured in the running app). The quality ladder runs its
   *  first pass before any frame exists, so this is the only source of truth it has that does not
   *  depend on a <video> element having rendered. */
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
/**
 * The same net for a MINIMISED window, which is a different animal: measured, it produces no frames
 * at all and is never reported closed, so the ordinary counter would end a share after two minutes
 * of a window the host merely put away. Far longer, but not absent — a capture can still die while
 * minimised, and "the addon says nothing" must not mean "repeat for ever".
 */
const MAX_MINIMIZED_REPEATS = 3600; // 30 minutes
/** Both thresholds are minutes long by design, and no test can wait them out. Overridable from a
 *  test page only; production never sets it, and reading it costs one property lookup per tick. */
const limitsOverride = (): { max?: number; minimized?: number } | undefined =>
  (window as unknown as { __ssRepeatLimits?: { max?: number; minimized?: number } }).__ssRepeatLimits;
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
 * Start native capture of the display the shell approved, and return it as a track.
 *
 * Which display is not ours to say — see `startNativeCapture` in global.d.ts. The shell captures
 * whatever the last confirmed pick approved, and throws if that is nothing.
 *
 * `sdrWhiteNits` is the tone map's divisor: what the display reports, times whatever correction the
 * host has dialled in (see the reference-white control in host.ts). The caller always passes one —
 * the parameter stays optional only because the addon has the same scRGB fallback of 80, which on a
 * real HDR desktop is wrong by whatever the SDR brightness slider is set to: measured at 6x here,
 * and the difference between 0% and 70% of the highlights clipping.
 */
export async function captureNative(
  sdrWhiteNits?: number,
  fps?: number,
  /** Called when the display the capture sits on reports a DIFFERENT reference white — a captured
   *  window dragged to another screen, or the Windows SDR brightness slider moved. Polled off the
   *  repeater, which already ticks at 2 Hz, so this costs no new timer and no new IPC. */
  onDisplayWhite?: (nits: number) => void,
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
      native.startNativeCapture?.(sdrWhiteNits, fps);
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
  /** Last white reported by the addon, so the callback fires on change and not on every tick. */
  let reportedWhite = 0;
  /**
   * Frames this module owns right now: received or created, and neither written nor closed.
   *
   * The header of this file states an invariant — every frame is either written (the track takes
   * ownership and closes it) or closed here — and until now nothing checked it, while three
   * separate leaks were found by reading the code. This is the check. It cannot count what the
   * track's sink does internally (that closes frames without going through JS), and it does not
   * need to: what leaked, every time, was OUR side letting a frame fall between two paths.
   *
   * Steady state is 1 — the `last` clone kept for the repeater — with a brief 2 while a new frame
   * replaces it. Anything that climbs is the leak this file exists to avoid, and ~30 of them is
   * enough to wedge the renderer (measured).
   */
  let held = 0;

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

  /** Every disposal goes through here, so the counter cannot drift away from the frames. */
  const release = (frame: VideoFrame): void => {
    frame.close();
    held--;
  };

  const send = (frame: VideoFrame): void => {
    writing = true;
    lastWriteMs = performance.now();
    // Ownership passes to the writer here, whatever happens next: a write that succeeds has the
    // track close the frame, and a write that rejects is closed by the catch below. Either way it
    // is no longer ours to account for.
    held--;
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
   * as long as it is, and why that branch is not the one doing the work. A minimised window gets
   * MAX_MINIMIZED_REPEATS instead: same net, sized for a state that is legitimately silent.
   */
  const repeater = setInterval(() => {
    if (stopped) return;
    // One read per tick, for the three things that are only observable from the addon.
    const stats = window.native?.nativeCaptureStats?.();
    // The display the capture is on may have changed under us — a captured window dragged to
    // another screen, or the Windows SDR brightness slider moved. The divisor is the caller's to
    // recompute (it is this times their own correction), so hand over the raw value and let them.
    // `?? 0` because these three fields are OPTIONAL: an older shell, and the non-Windows stub,
    // report neither. Unmeasured means "keep whatever we last had" — never divide by nothing.
    const white = (stats?.displaySdrWhiteMeasured ? stats.displaySdrWhiteNits : 0) ?? 0;
    if (white > 0 && white !== reportedWhite) {
      reportedWhite = white;
      onDisplayWhite?.(white);
    }
    // The death check runs FIRST, and in particular before the `!last` guard below. A capture can
    // die before it ever produces a frame — HDR switched off between the pick and the first frame,
    // or a capture item that was already closed — and treating "no frame yet" as "nothing to do"
    // left the host on a black preview labelled `live` for ever, which is the exact failure the
    // rest of this comment is about. `closed` is terminal in the addon (set by
    // GraphicsCaptureItem::Closed, cleared only by Stop), so this can never kill a live capture.
    const override = limitsOverride();
    const cap = stats?.minimized ? (override?.minimized ?? MAX_MINIMIZED_REPEATS) : (override?.max ?? MAX_REPEATS);
    if (repeats >= cap || stats?.closed) {
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
    // Counted either way — the threshold above is what differs. A monitor always changes
    // eventually, which is what makes MAX_REPEATS safe there; a minimised window produces nothing
    // at all for as long as it stays minimised (measured), so it gets the far longer cap rather
    // than no cap: not counting at all would mean a capture that dies while minimised repeats for
    // ever, which is the exact failure this whole branch exists to prevent.
    repeats++;
    try {
      // A monotonically increasing timestamp, tracked separately from the source frame: the encoder
      // is entitled to discard a repeat that carries the same one, and `last` does not move.
      const repeat = new VideoFrame(last, { timestamp: lastSentUs + IDLE_REPEAT_MS * 1000 });
      held++;
      send(repeat);
    } catch {
      /* the source frame was closed under us; the next real frame restarts the cycle */
    }
  }, IDLE_REPEAT_MS);

  port.onmessage = (event: MessageEvent<VideoFrame>): void => {
    const frame = event.data;
    held++; // transferred to us: ours to write or to close, from this line on
    // Never queue. (Not "newest wins": the frame kept is the one already being written, i.e. the
    // older one — we refuse the arrival.) Awaiting each write while frames keep arriving would
    // build an unbounded backlog, which on a live stream is worse than a dropped frame: latency
    // grows without bound and never recovers.
    if (stopped || writing) {
      dropped++;
      release(frame);
      return;
    }
    height = frame.codedHeight;
    if (last) release(last);
    // `last = null` FIRST, and the clone guarded: `clone()` throws on a detached frame, and the
    // old shape left `last` pointing at the frame just released — so the next arrival released it
    // a second time. `close()` is idempotent, the counter is not: it would drift down for ever and
    // the leak gate would read healthy while frames piled up. The repeater does the same dance
    // correctly three lines below; this path did not.
    last = null;
    try {
      // `clone()` shares the buffer rather than copying it, but it is a second reference to a
      // hardware buffer all the same — so it counts, and it is released above on the next frame.
      last = frame.clone();
      held++;
    } catch {
      release(frame); // ours, and now nothing else will take it
      return;
    }
    repeats = 0; // a real frame means the capture is alive; the give-up counter starts over
    send(frame);
  };

  return {
    track: generator,
    droppedInPage: () => dropped,
    height: () => height,
    heldFrames: () => held,
    // Both guarded on `stopped`: the addon is a process-wide singleton, so a NativeCapture the host
    // has already dropped would otherwise reach across and re-tune the session that replaced it.
    // Not reachable today (stopNative nulls the reference first), and one line each to keep it that
    // way for the next caller.
    setFps: (value: number) => {
      if (!stopped) native.setCaptureFps?.(value);
    },
    setSdrWhite: (nits: number) => {
      if (!stopped) native.setSdrWhite?.(nits);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(repeater);
      if (last) release(last);
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
