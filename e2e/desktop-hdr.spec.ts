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
  // The other half of the "captured without HDR" chip asserted in the fallback tests below: a
  // warning that is always on says nothing. Same HDR source, captured natively, so it is off.
  await expect(page.locator('#host-hdr-clamped')).toBeHidden();

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

// …and turning it back on afterwards must actually produce sound. The native capture is video-only
// and `getDisplayMedia` was never called, so flipping the flag alone rebuilt from a stream with no
// audio track in it: silence, with the panel showing "system" lit. The host cannot hear their own
// share, so nothing on their machine reveals it — it was in the backlog for that reason.
test('system audio turned on after the native capture started reaches the share', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  await shareHdrScreen(page, async (p) => p.click('#toggle-sysaudio'));
  await previewHeight(page).toBe(720);

  await page.click('#btn-settings');
  await page.click('#toggle-sysaudio');

  // The same grab captureHdr does — video sibling stopped, or it is a second full screen capture
  // running for nothing.
  await displayMediaCalls(page).toEqual([{ audio: true, videoStopped: true }]);
  // And it lands in the shared stream, which is what buildOutgoing reads. Not just "the toggle
  // stayed lit": a failed grab turns it back off, so the toggle alone proves only half of it.
  await expect
    .poll(() =>
      page.evaluate(
        () => ((document.getElementById('host-video') as HTMLVideoElement).srcObject as MediaStream).getAudioTracks().length,
      ),
    )
    .toBe(1);
  await expect(page.locator('#toggle-sysaudio')).toHaveAttribute('aria-pressed', 'true');

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
  const movedAt = Date.now();
  await page.evaluate(() => {
    (window as unknown as { __nativeWhite: number }).__nativeWhite = 80;
  });
  await expect(page.locator('#sdrwhite-value')).toHaveText('80 nits');
  await nativeCalls(page).toMatchObject({ sdrWhite: [80] });
  // HOW FAST, not just eventually. Every frame between the move and this update is tone-mapped with
  // the other screen's white — 480 against 80, so six times too dark — and "eventually" passes at
  // any poll rate because the expect retries. Reported from real use as a visible flash. 350 ms is
  // the discriminator: POLL_MS=100 lands in ~100-200, the old 500 ms tick in ~500-600.
  expect(Date.now() - movedAt).toBeLessThan(350);

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
// frozen image.
//
// The share ENDS here; it is not recaptured. A version of this feature restarted a screen whose
// item had closed, on the reasoning that the monitor is usually still present — with Win+Alt+B as
// the named case. tools/hdr-toggle-recovery.cjs measured that case and it does not close the item
// at all (the capture keeps running and the white moves), so the recovery was answering a question
// nobody had; the remaining closer for a monitor would be an unplug, where restarting is the wrong
// reflex. See onSourceEnded.
test('a capture that dies ends the share instead of freezing on the last frame', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page, { nativeCapture: 'ok' });
  await shareHdrScreen(page);
  await previewHeight(page).toBe(720);

  await page.evaluate(() => {
    (window as unknown as { __nativeClosed: boolean }).__nativeClosed = true;
  });

  await expect(page.locator('#host-empty')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#host-live-badge')).toBeHidden();
  // And the session is released, not just the track: stopSource has to reach the shell.
  await nativeCalls(page).toMatchObject({ stopped: 1 });
  // …and the host is TOLD. A share that ends by itself and leaves them on "choose source" with no
  // explanation is the worst version of this. The wording names the display rather than Win+Alt+B,
  // which it used to: an HDR toggle is measured NOT to cause this, and a message naming a cause
  // that cannot produce the effect sends the host to fix the wrong thing.
  await expect(page.locator('#host-ended-reason')).toBeVisible();
  await expect(page.locator('#host-ended-reason')).toContainText('display changed or was disconnected');

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

// The same death one keystroke earlier: the item is closed BEFORE the first frame. `last` is null,
// so the repeater's "nothing to repeat" guard used to swallow the whole check and the host sat on a
// BLACK preview labelled live, for ever — worse than the frozen frame above, and invisible to every
// other test here, all of which wait for a frame before doing anything.
//
// On a WINDOW, which is the only closer anyone has measured (`GraphicsCaptureItem::Closed` does
// fire when the window is destroyed — tools/window-hdr-probe.cjs), and which earns its own message:
// the app is gone, and its handle may already belong to another process since Windows recycles them.
test('a capture that dies before its first frame ends the share too, and names the app', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true });
  // Dead before the picker even resolves: the handover happens, no frame ever follows.
  await fakeNative(page, { nativeCapture: 'ok' });
  await page.addInitScript(() => {
    (window as unknown as { __nativeClosed: boolean }).__nativeClosed = true;
  });
  await openPicker(page);
  await pick(page, 'window', 'Elden Ring');

  await expect(page.locator('#host-empty')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#host-live-badge')).toBeHidden();
  await expect(page.locator('#host-ended-reason')).toContainText('That app closed');
  // Exactly one start, ever. A dead capture is never restarted — and for a window in particular,
  // restarting could capture whatever process inherited the handle.
  await nativeCalls(page).toMatchObject({ started: [{ device: 'hwnd:4242' }] });

  await ctx.close();
});

// Blind spot (b): `hdr` is decided when the picker lists. A window picked while it sat on the SDR
// monitor kept that verdict for ever, however far the host dragged it — the share stayed washed out
// with only the "captured without HDR" chip to show for it. (The other direction already worked: a
// native capture follows the reference white across screens.) Nothing re-lists when a window moves,
// and no Electron event fires either, so the renderer asks.
test('a clamped window dragged onto an HDR screen is upgraded to native, keeping its sound', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true, sizes: [[1920, 1080]] });
  await fakeNative(page, { nativeCapture: 'ok' });
  await openPicker(page);
  await pick(page, 'window', 'Discord'); // SDR in the listing → the clamped getDisplayMedia path

  await previewHeight(page).toBe(1080);
  await expect(page.locator('#host-hdr-clamped')).toBeHidden(); // an SDR source is not "clamped"
  const audioTrackId = await page.evaluate(
    () => ((document.getElementById('host-video') as HTMLVideoElement).srcObject as MediaStream).getAudioTracks()[0]?.id,
  );
  expect(audioTrackId).toBeTruthy();

  // The host drags it onto the HDR panel. Only the shell can see this.
  await page.evaluate(() => {
    (window as unknown as { __hdrNow: Record<string, unknown> }).__hdrNow = {
      'window:12:0': { hdr: true, sdrWhiteNits: 480, sdrWhiteMeasured: true },
    };
  });

  // The HANDLE, not the display underneath it — and at the white the shell reports NOW, not the 0
  // the listing carried for an SDR window. A divisor of 0 would be a division by zero in the shader.
  await nativeCalls(page).toMatchObject({ started: [{ device: 'hwnd:12', sdrWhiteNits: 480 }] });
  await previewHeight(page).toBe(720); // the native producer's size, so frames really switched over
  await expect(page.locator('#host-live-badge')).toBeVisible();
  await expect(page.locator('#host-source-name')).toHaveText('Discord');
  // The loopback track getDisplayMedia handed over is carried across, alive. The native capture
  // produces no audio of its own and cannot ask for any — `getDisplayMedia` needs a user gesture
  // and this runs off a timer — so losing it here would silently mute the share for good.
  expect(
    await page.evaluate(() => {
      const tracks = ((document.getElementById('host-video') as HTMLVideoElement).srcObject as MediaStream).getAudioTracks();
      return tracks.map((t) => ({ id: t.id, state: t.readyState }));
    }),
  ).toEqual([{ id: audioTrackId, state: 'live' }]);
  // …and its video sibling is stopped: the whole point is to stop paying for the clamped capture.
  await displayMediaCalls(page).toMatchObject([{ audio: true, videoStopped: true }]);

  await ctx.close();
});

// An upgrade that keeps failing must give up. The watcher ticks for the whole life of a clamped
// share, and each attempt is ~171 ms of synchronous C++ on the renderer's main thread — retrying
// every 2 s for ever is silent jank on a live share with no ceiling. And the share it is upgrading
// must survive every one of those failures untouched: nothing has been torn down when a start
// throws, which is the whole reason swapToNative returns false instead of raising.
test('an upgrade that keeps failing gives up, and never disturbs the share it could not upgrade', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true, sizes: [[1920, 1080]] });
  await fakeNative(page, { nativeCapture: 'ok' });
  await openPicker(page);
  await pick(page, 'window', 'Discord');
  await previewHeight(page).toBe(1080);

  await page.evaluate(() => {
    (window as unknown as { __nativeFail: boolean }).__nativeFail = true;
    (window as unknown as { __hdrNow: Record<string, unknown> }).__hdrNow = {
      'window:12:0': { hdr: true, sdrWhiteNits: 480, sdrWhiteMeasured: true },
    };
  });

  // Three attempts at a 2 s tick, then silence. The upper bound is what matters, so give the
  // watcher several more ticks' worth of room than the budget allows before counting.
  await nativeCalls(page).toMatchObject({ started: [{}, {}, {}] });
  await page.waitForTimeout(6000);
  expect(await page.evaluate(() => (window as unknown as { __native: NativeCalls }).__native.started.length)).toBe(3);
  // The clamped share is exactly as it was: same source, same size, still live, and still only the
  // one getDisplayMedia call it started with.
  await expect(page.locator('#host-live-badge')).toBeVisible();
  await expect(page.locator('#host-source-name')).toHaveText('Discord');
  await previewHeight(page).toBe(1080);
  await displayMediaCalls(page).toHaveLength(1);

  await ctx.close();
});

// The last HDR blind spot. `hdr` was `output?.hdr ?? false`, so "the shell resolved this output and
// it is SDR" and "the shell resolved nothing" arrived as the same false — and the chip, derived
// from that flag, stayed hidden for both. An installation whose capture addon never loaded reports
// every source SDR, clamps every share, and says NOTHING. That shipped once, with a missing
// `extraResources` entry: HDR absent from the whole app, every counter green.
//
// `hdrKnown` separates them, and the media query is the filter that keeps it from becoming noise —
// measured per-display and in agreement with DXGI (tools/dynamic-range-probe.cjs).
test('a share the shell could not classify says so, but only on a display that could be HDR', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true, sizes: [[1920, 1080]] });
  // The broken installation: no native capture, and nothing resolved, so every source reads SDR.
  await fakeNative(page, { hdrUnknown: true, dynamicRangeHigh: true });
  await openPicker(page);
  await pick(page, 'screen', 'Screen 1');

  await previewHeight(page).toBe(1080);
  // Nothing claimed the source was HDR — this is the chip earned by NOT KNOWING.
  expect(await page.evaluate(() => (window as unknown as { __listed?: number[] }).__listed?.length)).toBe(1);
  await expect(page.locator('#host-hdr-clamped')).toBeVisible();
  await expect(page.locator('#host-hdr-clamped')).toHaveText('captured without HDR');

  await ctx.close();
});

// …and the other half, which is what stops it being permanent noise: the same broken shell on a
// machine whose panel cannot do HDR at all. The words would still be true and would say nothing
// worth reading, on every share, for ever.
test('a shell that cannot classify stays quiet on a display that could not be HDR anyway', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true, sizes: [[1920, 1080]] });
  await fakeNative(page, { hdrUnknown: true, dynamicRangeHigh: false });
  await openPicker(page);
  await pick(page, 'screen', 'Screen 1');

  await previewHeight(page).toBe(1080);
  await expect(page.locator('#host-hdr-clamped')).toBeHidden();

  await ctx.close();
});

// And a WORKING shell that resolved the output and read SDR must stay quiet too, whatever the panel
// in front of the host can do. This is the assertion that keeps the media query from leaking onto
// the normal path: it is only consulted when the shell has already failed to answer.
test('a resolved SDR source stays quiet even on an HDR-capable display', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true, sizes: [[1920, 1080]] });
  await fakeNative(page, { dynamicRangeHigh: true }); // resolved: hdrKnown true, Screen 2 is SDR
  await openPicker(page);
  await pick(page, 'screen', 'Screen 2');

  await previewHeight(page).toBe(1080);
  await expect(page.locator('#host-hdr-clamped')).toBeHidden();

  await ctx.close();
});

// The silent source substitution the `expectId` echo exists to stop. The shell's `selectedSourceId`
// moves the instant the picker confirms, while the capture behind it can still fail — so the shell
// can be approving a source the page never committed to. Harmless while every native start sat
// inside the click that made the pick; the HDR watcher above starts one off a TIMER, and without
// the echo it would have captured whatever the shell was holding and relabelled the stage with it.
test('a pick the host never committed to is never swapped into the live share', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, { audio: true, sizes: [[1920, 1080]] });
  await fakeNative(page, { nativeCapture: 'ok' });
  await openPicker(page);
  await pick(page, 'window', 'Discord');
  await previewHeight(page).toBe(1080);

  // The shell is left holding a DIFFERENT source — the state after a pick whose capture failed —
  // and that source is on an HDR display, i.e. everything the watcher is looking for.
  await page.evaluate(() => {
    (window as unknown as { __picked: string }).__picked = 'screen:0:0';
    (window as unknown as { __hdrNow: Record<string, unknown> }).__hdrNow = {
      'screen:0:0': { hdr: true, sdrWhiteNits: 480, sdrWhiteMeasured: true },
    };
  });

  // Three watcher ticks' worth. Nothing starts, and the share stays what the host chose.
  await page.waitForTimeout(6000);
  expect(await page.evaluate(() => (window as unknown as { __native: NativeCalls }).__native.started)).toEqual([]);
  await expect(page.locator('#host-source-name')).toHaveText('Discord');
  await previewHeight(page).toBe(1080);

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

  expect(stamps.length).toBeGreaterThanOrEqual(3);
  // THE SPACING, and it is the only thing guarding the two-constant split in native-video.ts. The
  // timer now ticks at POLL_MS (100) while repeats stay on IDLE_REPEAT_MS (500), so the obvious
  // "why are there two of these" cleanup would silently make repeats fire 5x too often and their
  // timestamps advance 5x too slowly. It used to be unassertable — with the tick and the threshold
  // both at 500, jitter made a repeat land at 500 ms or at 1000 — which is exactly what the faster
  // tick fixed: the guard is now sampled every 100 ms, so spacing is 500 ms plus at most one tick.
  // Exact, not a band: the source is stalled, so these are all repeat-to-repeat, and a repeat's
  // stamp is the previous one plus IDLE_REPEAT_MS by integer arithmetic. Substituting POLL_MS there
  // makes every gap 100 and this fails on the first sample instead of drifting.
  const gaps = stamps.slice(1).map((v, i) => (v - stamps[i]) / 1000); // µs → ms
  // The FIRST gap can straddle the last real frame, which arrived on its own clock. Every one after
  // it is repeat to repeat.
  for (const gap of gaps.slice(1)) expect(gap).toBe(500);
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
    // …and the host is TOLD. The fallback is correct but it clamps HDR, so the picture is washed
    // out for reasons nothing on screen used to explain: the only clue was the absent #sdrwhite-row,
    // a control most hosts have never seen.
    await expect(page.locator('#host-hdr-clamped')).toBeVisible();
    await previewHeight(page).toBe(1080);
    await nativeCalls(page).toMatchObject({ stopped: stops });

    // …and it goes away on the next source. THIS is the assertion the derivation exists for: a
    // sticky flag set in the two failure routes passes everything above and still fails here,
    // because then every success route has to remember to clear it. Screen 2 is not HDR.
    await page.click('#btn-settings');
    await page.click('#btn-modal-source');
    await pick(page, 'screen', 'Screen 2');
    await expect(page.locator('#host-hdr-clamped')).toBeHidden();

    await ctx.close();
  });
}

// The refusal that has ALREADY destroyed something. On a native→native switch, captureHdr stops the
// running WGC session before it starts the next one — and a deliberate stop is silent by design, so
// nothing fires `ended`. If the getDisplayMedia fallback is then refused too, `setStream` never
// runs: the stage used to keep a live badge, a Stop button and the previous source's name over a
// dead track, with the viewers holding a frozen picture and nothing anywhere saying it was over.
// The host cannot see any of that from their own machine.
test('a fallback refused after the native session was killed ends the share and says why', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Rejects from the SECOND call on: the first share's audio grab must succeed, so that what the
  // switch below tears down is a real, running native session.
  await fakeDisplayMedia(page, { audio: true, rejectFrom: 1 });
  await fakeNative(page, { nativeCapture: 'ok' });
  await shareHdrScreen(page);
  await previewHeight(page).toBe(720);
  await expect(page.locator('#host-live-badge')).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __nativeFail: boolean }).__nativeFail = true;
  });
  await page.click('#btn-settings');
  await page.click('#btn-modal-source');
  await pick(page, 'screen', 'Screen 1');

  // Ended, not "live over a corpse" — and wearing the reason, which is the whole point: this is a
  // teardown the host did not ask for.
  await expect(page.locator('#host-live-badge')).toBeHidden();
  await expect(page.locator('#host-empty')).toBeVisible();
  await expect(page.locator('#host-ended-reason')).toContainText('fallback was refused');

  await ctx.close();
});
