import { test, expect, type Page } from '@playwright/test';
import { fakeDisplayMedia, fakeNative } from './fake-media.ts';

// The native HDR path (src/lib/native-video.ts + HostController.captureHdr), which had no
// automated coverage at all: the rest of the suite pins `canCaptureNative()` to false, and the
// harness in tools/native-track.cjs proves the addon→track chain without loading a line of
// host.ts. Everything the routing does — pick the path, fetch audio separately, own the session,
// route fps, notice the capture dying, fall back — lived on review and hand-testing only, which is
// exactly where three leaks were found.
//
// What runs for real here: the picker, host.ts, native-video.ts, MediaStreamTrackGenerator, the
// port handover contract. What is faked: the producer (a canvas instead of a C++ addon) and the
// shell's side of the consent gate — the fake resolves the approved display from the pick the same
// way main does. What is NOT covered by any of this: the addon itself, and Electron's IPC wiring
// (the gate's own logic is unit-tested in electron/src/config.test.ts).

interface NativeCalls {
  started: Array<{ device: string; sdrWhiteNits?: number; fps?: number }>;
  stopped: number;
  fps: number[];
  sdrWhite: number[];
}
interface GdmCall {
  audio: boolean;
  videoStopped: boolean;
}

const nativeCalls = (page: Page) =>
  expect.poll(() => page.evaluate(() => (window as unknown as { __native: NativeCalls }).__native));
const displayMediaCalls = (page: Page) =>
  expect.poll(() => page.evaluate(() => (window as unknown as { __gdm?: GdmCall[] }).__gdm ?? []));
/** Frames actually reaching the page: the preview only reports a height once one has rendered. */
const previewHeight = (page: Page) =>
  expect.poll(() => page.evaluate(() => (document.getElementById('host-video') as HTMLVideoElement).videoHeight));

/** Open a room and reach the picker. `settings` runs while the panel is open, before the pick. */
async function openPicker(page: Page, settings?: (p: Page) => Promise<void>): Promise<void> {
  await page.goto('/');
  await page.click('#btn-start');
  await expect(page.locator('#host-code')).not.toHaveText('—');
  await page.click('#btn-choose-source');
  await settings?.(page);
  await page.click('#btn-modal-source');
}

async function pick(page: Page, kind: 'screen' | 'window', name: string): Promise<void> {
  await page.locator(`#source-grid-${kind} button`, { hasText: name }).click();
  await page.click('#btn-source-confirm');
}

// Screen 1 is the HDR one in the fake source list, with a MEASURED SDR white of 480 nits.
async function shareHdrScreen(page: Page, settings?: (p: Page) => Promise<void>): Promise<void> {
  await openPicker(page, settings);
  await pick(page, 'screen', 'Screen 1');
}

test('an HDR screen is captured natively, with system audio fetched on the side', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  await shareHdrScreen(page);

  await expect(page.locator('#host-video')).toBeVisible();
  await expect(page.locator('#host-live-badge')).toBeVisible();
  // The screen that gets captured is the one whose tile was clicked — resolved by the shell from
  // that pick, not named by the page, which is never told a device name at all. And the MEASURED
  // white level reaches the addon: its own fallback is the scRGB definition (80), wrong by 6x on
  // this machine and 70% of the highlights clipped, so `sdrWhiteMeasured` deciding between 480 and
  // *undefined* (never 80) is what the whole tone map hangs on.
  await nativeCalls(page).toMatchObject({
    started: [{ device: String.raw`\\.\DISPLAY1`, sdrWhiteNits: 480, fps: 60 }],
  });

  // Exactly ONE getDisplayMedia call, for the audio, with its video sibling stopped. Two failures
  // hide here and neither is visible on screen: no call at all silently mutes the share, and a
  // video track left running is a second full screen capture nobody consumes.
  await displayMediaCalls(page).toEqual([{ audio: true, videoStopped: true }]);
  // …and that track is actually in the shared stream. The native capture is video-only, so this is
  // the assertion that turning HDR on has not silently muted the share — the failure mode
  // loopbackAudioTrack exists for, and the one the host cannot hear from their own machine.
  expect(
    await page.evaluate(() => ((document.getElementById('host-video') as HTMLVideoElement).srcObject as MediaStream).getAudioTracks().length),
  ).toBe(1);
  await expect(page.locator('#toggle-sysaudio')).toHaveAttribute('aria-pressed', 'true');

  // Frames really arrive — without this the whole suite stays green on a handover that works and a
  // track nothing ever writes to.
  await previewHeight(page).toBe(720);
  // And the quality ladder read that height: 720 caps the panel's "up to 4K" default. Note what
  // this does NOT prove — `sourceHeight()` prefers `nativeCapture.height()` precisely because
  // `videoHeight` is still 0 for the FIRST offer, and by now both agree on 720.
  await expect(page.locator('#chip-resolution')).toHaveText('720p');

  await ctx.close();
});

// System audio off must mean no getDisplayMedia at all on this path. It is the only call that can
// raise an OS screen-share prompt, and raising one to fetch audio nobody asked for would be a
// second consent dialog on top of the picker the user already used.
test('with system audio off, the native path never touches getDisplayMedia', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  await shareHdrScreen(page, async (p) => p.click('#toggle-sysaudio'));

  await previewHeight(page).toBe(720);
  // A plain expect, not a poll: the share is already running by now, so "no call yet" would be a
  // poll that passes on its first sample no matter what.
  expect(await page.evaluate(() => (window as unknown as { __gdm?: GdmCall[] }).__gdm ?? [])).toEqual([]);

  await ctx.close();
});

// Switching away from an HDR screen: only one WGC session can exist at a time, so a leaked one
// makes the NEXT native share impossible ("capture already running") — and it keeps tone-mapping a
// screen for a track nobody reads.
//
// The pause is not incidental. `NativeCapture.stop()` used to close the writable, which ends the
// track from the source side and fires `ended` — the event host.ts listens to for "the source is
// gone". So every deliberate stop ran stopSource() inside capture()'s own await: the share
// un-paused itself and the per-app mutes went with it. Measured, then fixed by ending the track
// silently on a deliberate stop (see endTrack in native-video.ts).
test('switching off an HDR screen releases the session and keeps the share paused', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  await shareHdrScreen(page);
  await previewHeight(page).toBe(720);

  await page.click('#btn-pause');
  await expect(page.locator('#host-paused-badge')).toBeVisible();

  await page.click('#btn-settings');
  await page.click('#btn-modal-source');
  await pick(page, 'window', 'Discord');

  await nativeCalls(page).toMatchObject({ stopped: 1 });
  // The window went through getDisplayMedia — and unlike the HDR path's audio-only call, this one
  // keeps its video track. Asserting the shape, not just the count: the day the ordinary path
  // starts stopping its own video, the share goes black and a length check would not notice.
  await displayMediaCalls(page).toEqual([
    { audio: true, videoStopped: true },
    { audio: true, videoStopped: false },
  ]);
  await expect(page.locator('#host-paused-badge')).toBeVisible();
  await expect(page.locator('#host-live-badge')).toBeHidden();

  await ctx.close();
});

// The other half of that fix, and the one it nearly broke. Ending the native session up front —
// which the code did for EVERY source change — is destructive and, now that a deliberate stop is
// silent, undetectable: if the next capture then fails, the host is left on the last HDR frame,
// badge lit, nobody told. So the session is only ended up front when the new source is native too,
// which is the only case the one-session-at-a-time rule forces.
test('a capture that fails after an HDR share leaves that share running', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Call 0 is the HDR share's audio and succeeds; call 1 is the window capture and refuses.
  await fakeDisplayMedia(page, { audio: true, rejectFrom: 1 });
  await fakeNative(page, { nativeCapture: 'ok' });
  await shareHdrScreen(page);
  await previewHeight(page).toBe(720);

  await page.click('#btn-settings');
  await page.click('#btn-modal-source');
  await pick(page, 'window', 'Discord');

  // The picker says so and stays open — the message belongs there, the settings panel is behind it.
  await expect(page.locator('#source-status')).toHaveText('capture failed — try another source');
  await expect(page.locator('#source-modal')).toBeVisible();
  // The HDR share survived: still live, and its session was never stopped.
  await expect(page.locator('#host-live-badge')).toBeVisible();
  await nativeCalls(page).toMatchObject({ stopped: 0 });
  const before = await page.evaluate(() => (window as unknown as { __native: NativeCalls }).__native.started.length);
  expect(before).toBe(1);

  await ctx.close();
});

// A MediaStreamTrackGenerator rejects applyConstraints outright (OverconstrainedError, measured),
// so the fps setting can only be honoured by the addon. Pause routes there too: paused means
// nobody receives the video, but WGC and the tone map would otherwise carry on at full rate.
test('fps and pause are applied to the addon, which is the only thing that can honour them', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  await shareHdrScreen(page);
  await previewHeight(page).toBe(720);

  await page.click('#btn-settings');
  await page.click('[data-fps="30"]');
  await page.click('#btn-settings-done');
  await page.click('#btn-pause');
  await expect(page.locator('#host-paused-badge')).toBeVisible();
  await page.click('#btn-resume');
  await expect(page.locator('#host-live-badge')).toBeVisible();

  // 60 on start, 30 from the panel, 1 while paused, 30 again on resume — the last one is the
  // regression that matters: resuming at the paused rate would leave the share at 1 fps.
  await nativeCalls(page).toMatchObject({ fps: [60, 30, 1, 30] });

  await ctx.close();
});

// The tone map divides by the display's reference white. Windows reports it (480 nits here, where
// the scRGB default of 80 would clip 70% of the highlights) but it IS the user's own brightness
// slider, so the reading can be right and the picture still wrong. This is the correction, and it
// has to reach the addon live — restarting a capture to honour a slider would be absurd.
test('the HDR reference white reaches the shell, and only exists on the native path', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  await shareHdrScreen(page);
  await previewHeight(page).toBe(720);

  await page.click('#btn-settings');
  await expect(page.locator('#sdrwhite-row')).toBeVisible();
  await expect(page.locator('#sdrwhite-value')).toHaveText('480 nits'); // exactly what the display reports

  // One stop up = twice the divisor, i.e. a DARKER picture — which is why the control is labelled
  // as the white level and not as brightness. Exponential, so "as reported" sits at the centre of
  // the travel rather than a third of the way along.
  await page.locator('#sdrwhite-range').fill('1');
  await expect(page.locator('#sdrwhite-value')).toHaveText('960 nits');
  await nativeCalls(page).toMatchObject({ sdrWhite: [960] });

  // And a way back, because an exposure control without one is a trap.
  await page.click('#btn-sdrwhite-auto');
  await expect(page.locator('#sdrwhite-value')).toHaveText('480 nits');
  await nativeCalls(page).toMatchObject({ sdrWhite: [960, 480] });

  // It survives a restart — a correction the host had to find by eye should not be found twice.
  await page.locator('#sdrwhite-range').fill('-1');
  await expect(page.locator('#sdrwhite-value')).toHaveText('240 nits');
  // `goto('/')`, NOT `reload()`: hosting puts the room code in the hash, and reloading `/#CODE`
  // lands on the JOIN screen — which is a 60 s timeout and a very confusing snapshot. (Ask me how
  // I know. It is also the shape of a flake that cost an afternoon.)
  await page.goto('/');
  await shareHdrScreen(page);
  await previewHeight(page).toBe(720);
  // Applied from the very first frame, not one repaint later: a capture that starts at the measured
  // white and jumps when the panel renders is a flash nobody asked for.
  await nativeCalls(page).toMatchObject({ started: [{ sdrWhiteNits: 240 }] });
  await page.click('#btn-settings');
  await expect(page.locator('#sdrwhite-value')).toHaveText('240 nits');

  // And it is gone on the getDisplayMedia path: no tone map there, so a knob would do nothing.
  await page.click('#btn-modal-source');
  await pick(page, 'window', 'Discord');
  await expect(page.locator('#host-video')).toBeVisible();
  await page.click('#btn-settings');
  await expect(page.locator('#sdrwhite-row')).toBeHidden();

  await ctx.close();
});

// Sharing an APP on an HDR screen. This was the last thing still washing out, and the cause was the
// routing rather than the tone map: `desktopCapturer` reports no display for a window (measured: 0
// of 4 carry a display_id), so nothing tied one to an HDR output and every app share fell back to
// the clamped path. The shell resolves it through the window HANDLE instead.
test('an app on an HDR screen is captured natively too, not just the whole screen', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  await openPicker(page);
  await pick(page, 'window', 'Elden Ring');

  await expect(page.locator('#host-live-badge')).toBeVisible();
  await previewHeight(page).toBe(720);
  // A HANDLE, not a display name: capturing the window itself, not the monitor underneath it —
  // which would share everything on that screen instead of the one app the host picked.
  await nativeCalls(page).toMatchObject({ started: [{ device: 'hwnd:4242', sdrWhiteNits: 480 }] });
  // And the reference-white control is offered here too: same tone map, same divisor.
  await page.click('#btn-settings');
  await expect(page.locator('#sdrwhite-value')).toHaveText('480 nits');

  await ctx.close();
});

// A window is not a screen: it can be dragged to a display with a different reference white — 480
// here, 80 on the SDR panel — and a divisor six times off is the whole bug this feature fixes.
// Nothing tells the page; the addon re-reads the display and the page follows it.
test('a captured window dragged to another screen follows its reference white', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  await openPicker(page);
  await pick(page, 'window', 'Elden Ring');
  await previewHeight(page).toBe(720);
  await page.click('#btn-settings');
  await expect(page.locator('#sdrwhite-value')).toHaveText('480 nits');

  // The window moves to the SDR panel: the display now reports 80.
  await page.evaluate(() => {
    (window as unknown as { __nativeWhite: number }).__nativeWhite = 80;
  });
  await expect(page.locator('#sdrwhite-value')).toHaveText('80 nits');
  await nativeCalls(page).toMatchObject({ sdrWhite: [80] });

  await ctx.close();
});

// A minimised window produces NO frames and is NOT reported closed (measured). Without a way to
// tell it from a dead capture, the repeater's give-up counter would end a share the host never
// stopped — after two minutes of a window they simply put away.
test('a minimised window keeps the share alive instead of counting towards giving up', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  // Both give-up thresholds are minutes long by design, so at real values this test would prove
  // nothing but "the badge is still lit three seconds in" — which the tests above already say. Cut
  // down: 4 ticks for an ordinary silent capture, 40 for a minimised one. The point is the
  // DIFFERENCE, and that only the second applies while the window is away.
  await page.addInitScript(() => {
    (window as unknown as { __ssRepeatLimits: unknown }).__ssRepeatLimits = { max: 4, minimized: 40 };
  });
  await openPicker(page);
  await pick(page, 'window', 'Elden Ring');
  await previewHeight(page).toBe(720);

  // Minimised: frames stop, nothing is reported dead, and no display can be resolved either.
  await page.evaluate(() => {
    const w = window as unknown as { __nativeMinimized: boolean; __nativeStall: boolean };
    w.__nativeMinimized = true;
    w.__nativeStall = true;
  });
  // Well past the ordinary threshold (4 × 500 ms): a share that counted minimised ticks the usual
  // way would already be over.
  await page.waitForTimeout(5000);
  await expect(page.locator('#host-live-badge')).toBeVisible();
  await expect(page.locator('#host-empty')).toBeHidden();
  // And the divisor did not follow the minimised window to nowhere: an unresolvable display reports
  // nothing measured, which must leave the last good value alone rather than divide by zero.
  await page.click('#btn-settings');
  await expect(page.locator('#sdrwhite-value')).toHaveText('480 nits');

  await ctx.close();
});

// The compatibility branch the control's own comment leans on: an installer that predates the
// reference white paired with a newer web bundle. HDR still runs — refusing it outright, the way
// `canCaptureNative` refuses a shell with no fps setter, would trade the feature for a slider — but
// the control is hidden, because a knob that does nothing is worse than a missing one.
test('an older shell that cannot set the reference white still captures, without the control', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok', noSdrWhite: true });
  await shareHdrScreen(page);

  await previewHeight(page).toBe(720); // the native path still runs
  await page.click('#btn-settings');
  await expect(page.locator('#sdrwhite-row')).toBeHidden();

  await ctx.close();
});

// The failure the repeater nearly created. WGC only produces a frame when something CHANGES, so
// native-video.ts repeats the last one on a still screen — which makes a DEAD capture
// indistinguishable from an idle one: green stats, a "live" badge, and viewers looking at one
// frozen image. Win+Alt+B (turn HDR off) gets there in one keystroke.
test('a capture that dies ends the share instead of freezing on the last frame', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  await shareHdrScreen(page);
  await previewHeight(page).toBe(720);

  // The frames stop AND the addon reports the capture item gone — what actually happens when the
  // display switches out of HDR mode.
  await page.evaluate(() => {
    (window as unknown as { __nativeClosed: boolean }).__nativeClosed = true;
  });

  await expect(page.locator('#host-empty')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#host-live-badge')).toBeHidden();
  // And the session is released, not just the track: stopSource has to reach the shell.
  await nativeCalls(page).toMatchObject({ stopped: 1 });
  // …and the host is TOLD. A share that ends by itself and leaves them on "choose source" with no
  // explanation is the worst version of this: the likeliest cause is one keystroke away, so the
  // message names it.
  await expect(page.locator('#host-ended-reason')).toBeVisible();
  await expect(page.locator('#host-ended-reason')).toContainText('Win+Alt+B');

  // And it does not linger: stopping the next share on purpose needs no explanation.
  await page.click('#btn-choose-source');
  await page.click('#btn-modal-source');
  await pick(page, 'window', 'Discord');
  await expect(page.locator('#host-video')).toBeVisible();
  await page.click('#btn-stop');
  await expect(page.locator('#host-empty')).toBeVisible();
  await expect(page.locator('#host-ended-reason')).toBeHidden();

  await ctx.close();
});

// The same death, one keystroke earlier: HDR switched off between the pick and the first frame.
// `last` is null, so the repeater's "nothing to repeat" guard used to swallow the whole check and
// the host sat on a BLACK preview labelled live, for ever — worse than the frozen frame above, and
// invisible to every other test here, all of which wait for a frame before doing anything.
test('a capture that dies before its first frame ends the share too', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  // Dead before the picker even resolves: the handover happens, no frame ever follows.
  await fakeNative(page, { nativeCapture: 'ok' });
  await page.addInitScript(() => {
    (window as unknown as { __nativeClosed: boolean }).__nativeClosed = true;
  });
  await shareHdrScreen(page);

  await expect(page.locator('#host-empty')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#host-live-badge')).toBeHidden();

  await ctx.close();
});

// The repeater's actual job, which nothing else here exercises: WGC produces a frame only when
// something CHANGES, so on a still screen the encoder gets no input, cannot answer a keyframe
// request, and a viewer joining at that moment sits on black. Every other test in this file runs
// with frames flowing at 15 fps, where the repeat branch is never even reached.
//
// Frames are counted off the shared track itself rather than inferred: "the badge is still lit"
// would be true even if the repeater did nothing at all.
test('a still screen keeps feeding the encoder', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  await shareHdrScreen(page);
  await previewHeight(page).toBe(720);

  const stamps = await page.evaluate(async () => {
    const video = document.getElementById('host-video') as HTMLVideoElement;
    const track = (video.srcObject as MediaStream).getVideoTracks()[0];
    const Processor = (
      window as unknown as {
        MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };
      }
    ).MediaStreamTrackProcessor;
    if (!Processor) throw new Error('MediaStreamTrackProcessor unavailable');
    const reader = new Processor({ track }).readable.getReader();
    // Only now: the reader has to be attached before the source goes quiet.
    (window as unknown as { __nativeStall: boolean }).__nativeStall = true;
    const out: number[] = [];
    const deadline = performance.now() + 2600;
    while (performance.now() < deadline) {
      // Raced against a timeout, or a repeater that does nothing would hang here instead of
      // failing an assertion.
      const read = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: VideoFrame }>((r) => setTimeout(() => r({ done: true }), 1200)),
      ]);
      if (read.done || !read.value) break;
      out.push(read.value.timestamp);
      read.value.close();
    }
    void reader.cancel();
    return out;
  });

  // ~500 ms apart over 2.6 s, minus the first repeat which can land up to 2×IDLE_REPEAT_MS after
  // the last real frame.
  expect(stamps.length).toBeGreaterThanOrEqual(3);
  // Strictly increasing: repeats used to be rebased on the source frame's own timestamp, so every
  // one of them carried the SAME value — which an encoder is entitled to drop, quietly undoing the
  // whole point of the repeater.
  expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  expect(new Set(stamps).size).toBe(stamps.length);
  await expect(page.locator('#host-live-badge')).toBeVisible();

  await ctx.close();
});

// Leaving the room tears the controller down without navigating. A WGC session that survives it
// outlives the share itself — it keeps a D3D device and a frame pump running for a page that no
// longer exists, and the next share cannot start. Scope: this covers destroy() against an
// INSTALLED session. The narrower leak found on review — a session assigned after an await, so
// destroy() ran in that window and found nothing — needs a teardown mid-handover, and this test
// waits for a frame first, so it is not that.
test('leaving the room releases the native session', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  await shareHdrScreen(page);
  await previewHeight(page).toBe(720);

  await page.click('#brand-host');
  await expect(page.locator('#screen-home')).toBeVisible();
  await nativeCalls(page).toMatchObject({ stopped: 1 });

  await ctx.close();
});

// A washed-out picture is a bad day; a share button that does nothing because a C++ addon
// misbehaved is a broken product. Both failure shapes must land on getDisplayMedia with the
// session released — a refusal that leaks the capture makes every later native share impossible.
// The exact stop count, not "at least one": the two modes release the session by different routes,
// and `>= 1` would be satisfied by captureHdr's catch alone — so the handover timeout could stop
// releasing the session entirely and this test would still pass.
for (const { mode, stops } of [
  { mode: 'throw', stops: 1 }, // captureHdr's catch, and nothing else: no port was ever handed over
  { mode: 'noport', stops: 2 }, // native-video's timeout gives up on it, then the catch stops it again
] as const) {
  test(`a native capture that fails (${mode}) falls back to getDisplayMedia`, async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await fakeDisplayMedia(page, { audio: true, sizes: [[1920, 1080]] });
    await fakeNative(page, { nativeCapture: mode });
    await shareHdrScreen(page);

    // `noport` waits out native-video's 3 s handover timeout before falling back.
    await expect(page.locator('#host-video')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#host-live-badge')).toBeVisible();
    await previewHeight(page).toBe(1080);
    await nativeCalls(page).toMatchObject({ stopped: stops });

    await ctx.close();
  });
}
