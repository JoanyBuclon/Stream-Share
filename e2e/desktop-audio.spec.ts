import { test, expect, type Page } from '@playwright/test';
import { fakeDisplayMedia, fakeNative } from './fake-media.ts';

// Per-app audio is desktop-only: the section stays hidden in a browser, and its markup ships in
// the web build, so stubbing window.native exercises the real wiring — everything but WASAPI.
// A ticked box means "viewers hear this app". Every bug in here is INAUDIBLE to the host, so the
// assertions are always the pair: what the shell is running, and what the panel claims.

/** Reach the settings panel with a source actually being shared: the per-app rows stay locked
 *  until there is audio to mute. On desktop "Choose source" opens OUR picker, not a prompt. */
async function shareAndOpenSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.click('#btn-start');
  await expect(page.locator('#host-code')).not.toHaveText('—');
  await page.click('#btn-choose-source');
  await page.click('#btn-modal-source');
  await page.locator('#source-grid-screen button').first().click();
  await page.click('#btn-source-confirm');
  await expect(page.locator('#host-video')).toBeVisible();
  await page.click('#btn-settings');
  await expect(page.locator('#audio-apps-section')).toBeVisible();
}

/** Share a WINDOW rather than a screen, then open the settings panel. */
async function shareWindowAndOpenSettings(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.click('#btn-start');
  await expect(page.locator('#host-code')).not.toHaveText('—');
  await page.click('#btn-choose-source');
  await page.click('#btn-modal-source');
  await page.locator('#source-grid-window button', { hasText: name }).click();
  await page.click('#btn-source-confirm');
  await expect(page.locator('#host-video')).toBeVisible();
  await page.click('#btn-settings');
  await expect(page.locator('#audio-apps-section')).toBeVisible();
}

interface FakeAudio {
  mode: string;
  names: string[];
  pids: number[];
}

/** What the shell is actually running. Polled: every click is a round trip. */
const captured = (page: Page) =>
  expect.poll(() => page.evaluate(() => (window as unknown as { __audio?: FakeAudio | null }).__audio));

/** Whether the renderer routes viewers onto the native track rather than the loopback one. It
 *  subscribes to the PCM feed exactly when it does, which is the only way to see that decision
 *  from the page — `__audio` alone only proves the shell was *asked* for the right thing. */
const onNativeTrack = (page: Page) =>
  expect.poll(() => page.evaluate(() => (window as unknown as { __chunkSub?: boolean }).__chunkSub));

/** Rewrite the fake process table: an app launching, restarting, or dropping to tray. */
const setApps = (page: Page, apps: Array<{ pid: number; name: string; title: string }>): Promise<void> =>
  page.evaluate((next) => {
    (window as unknown as { __apps: unknown[] }).__apps = next;
  }, apps);

const APPS = [
  { pid: 4444, name: 'Elden Ring', title: 'ELDEN RING' },
  { pid: 4001, name: 'Discord', title: '@someone - Discord' },
  { pid: 4002, name: 'Spotify', title: 'Spotify Premium' },
  { pid: 0, name: 'Ghost', title: 'about to exit' },
];

const row = (page: Page, name: string) => page.locator('#audio-apps-list button', { hasText: name });

/** Close and reopen the panel, which is what re-lists the running apps. */
async function reopenSettings(page: Page): Promise<void> {
  await page.click('#btn-settings-done');
  await expect(page.locator('#settings-modal')).toBeHidden();
  await page.click('#btn-settings');
  await expect(page.locator('#audio-apps-section')).toBeVisible();
}

// The requirement this feature exists for, beyond muting: sharing a window should send THAT app's
// sound and nothing else, without the user asking — and the boxes must say so.
test('sharing a window captures that app alone and ticks only its box', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // `audio: true` is what makes the toggle assertion at the bottom mean anything: main answers
  // `audio: 'loopback'` for a window too, so in production the whole desktop mix is sitting in this
  // stream, unused. Without it the fixture has no audio track at all and the over-share it is
  // supposed to pin cannot even be expressed.
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page);
  await shareWindowAndOpenSettings(page, 'Elden Ring');

  // Applied on the pick itself, by window handle, with no interaction in the panel.
  await captured(page).toMatchObject({ mode: 'include', names: ['Elden Ring'] });
  await expect(row(page, 'Elden Ring')).toHaveAttribute('aria-pressed', 'true');
  for (const other of ['Discord', 'Spotify', 'Ghost']) {
    await expect(row(page, other)).toHaveAttribute('aria-pressed', 'false');
  }

  // Ticking one back is an ordinary edit from there — nothing about the window pick is a mode.
  await row(page, 'Spotify').click();
  await captured(page).toMatchObject({ mode: 'include', names: ['Elden Ring', 'Spotify'] });

  // Off then on must land back on THIS app, not on the loopback track. That track is a whole
  // desktop mix (main answers `audio: 'loopback'` for a window too), it is sitting right there in
  // the stream, and buildOutgoing picks it up the moment no native session is running — so the
  // toggle used to turn a window share into a full-system broadcast, silently, with the panel
  // still naming one app.
  await page.click('#toggle-sysaudio');
  await captured(page).toBeNull();
  await page.click('#toggle-sysaudio');
  await captured(page).toMatchObject({ mode: 'include', names: ['Elden Ring'] });
  await onNativeTrack(page).toBe(true);
  // Re-armed and NOTHING else: a version that also grabbed a fresh loopback track after a
  // successful arm would satisfy every assertion above while leaving a second full screen capture
  // running for a track no one reads.
  expect(await page.evaluate(() => (window as unknown as { __gdm?: unknown[] }).__gdm?.length ?? 0)).toBe(1);

  await ctx.close();
});

// MainWindowHandle names one window per process, so a second top-level window has no owner to
// resolve. Sharing it must degrade to system sound *and say so*, never claim app-only silently.
test('a window with no resolvable owner degrades to system sound and says so', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareWindowAndOpenSettings(page, 'Google Chrome');

  await captured(page).toBeNull();
  await expect(page.locator('#audio-apps-hint')).toContainText('no app audio of its own');
  // Nothing was armed, so nothing is muted: viewers hear the whole machine.
  for (const app of ['Elden Ring', 'Discord', 'Spotify', 'Ghost']) {
    await expect(row(page, app)).toHaveAttribute('aria-pressed', 'true');
  }

  await ctx.close();
});

// The core of the checkbox model, including the mode flip the host cannot hear happening.
test('unticking one app excludes it, and a second switches to including the rest', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareAndOpenSettings(page);

  // A screen: every app ticked, no native capture at all — the loopback track already has it.
  await expect(page.locator('#audio-apps-list button')).toHaveCount(4);
  await captured(page).toBeNull();
  await expect(page.locator('#audio-apps-hint')).toHaveText('only apps with an open window are listed');

  // One mute stays on exclusion: the only mode that still carries windowless apps, Windows' own
  // sounds and anything started later.
  await row(page, 'Discord').click();
  await captured(page).toMatchObject({ mode: 'exclude', names: ['Discord'] });
  await expect(row(page, 'Discord')).toHaveAttribute('aria-pressed', 'false');

  // The second mute flips the whole capture inside out — and the hint says what that costs.
  await row(page, 'Ghost').click();
  await captured(page).toMatchObject({ mode: 'include', names: ['Elden Ring', 'Spotify'] });
  await expect(page.locator('#audio-apps-hint')).toContainText('anything started later is silent');
  await expect(row(page, 'Elden Ring')).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, 'Spotify')).toHaveAttribute('aria-pressed', 'true');

  // And back down to one: the warning goes with it, so it never lingers as a false alarm.
  await row(page, 'Ghost').click();
  await captured(page).toMatchObject({ mode: 'exclude', names: ['Discord'] });
  await expect(page.locator('#audio-apps-hint')).toHaveText('only apps with an open window are listed');

  await ctx.close();
});

// The regression the empty-include case exists for. Unticking everything is the most natural way
// to ask for silence; answering it with "no native capture" would hand viewers the loopback track
// and un-mute all four apps at once — the exact opposite, with nothing on screen to reveal it.
test('unticking every app is silence, not a fallback to hearing everything', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareAndOpenSettings(page);

  for (const app of ['Elden Ring', 'Discord', 'Spotify', 'Ghost']) await row(page, app).click();

  for (const app of ['Elden Ring', 'Discord', 'Spotify', 'Ghost']) {
    await expect(row(page, app)).toHaveAttribute('aria-pressed', 'false');
  }
  // A live capture holding nothing — NOT null, which is what routes viewers back to the loopback.
  await captured(page).toMatchObject({ mode: 'include', names: [] });
  // And the renderer must agree: an empty answer is a success, so viewers stay on the (silent)
  // native track. Reading `[]` as a refusal here is what would un-mute all four apps.
  await onNativeTrack(page).toBe(true);

  await ctx.close();
});

// An app that quit between the listing and the click: the shell can't resolve it and refuses. The
// panel must not go on claiming it is muted — that is the state where a host believes their voice
// chat is silenced and it is not.
test('an app that vanished before the click is not left showing as muted', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareAndOpenSettings(page);

  await row(page, 'Ghost').click();
  await expect(page.locator('#audio-apps-hint')).toContainText('did not take');
  await expect(row(page, 'Ghost')).toHaveAttribute('aria-pressed', 'true');
  await captured(page).toBeNull();

  await ctx.close();
});

// A refusal must be NON-DESTRUCTIVE. The shell resolves every target before it stops what is
// running, so a click it cannot honour leaves the previous capture alone. Get this wrong and one
// failed click un-mutes the app the host muted a minute ago, with the box still showing unticked.
test('a refused change leaves the running capture and the boxes exactly as they were', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareAndOpenSettings(page);

  await row(page, 'Discord').click();
  await captured(page).toMatchObject({ mode: 'exclude', names: ['Discord'] });

  await page.evaluate(() => {
    (window as unknown as { __audioFail: boolean }).__audioFail = true;
  });
  await row(page, 'Spotify').click();

  await expect(page.locator('#audio-apps-hint')).toContainText('did not take');
  await captured(page).toMatchObject({ mode: 'exclude', names: ['Discord'] }); // untouched
  await expect(row(page, 'Discord')).toHaveAttribute('aria-pressed', 'false'); // still muted
  await expect(row(page, 'Spotify')).toHaveAttribute('aria-pressed', 'true'); // never became muted
  await onNativeTrack(page).toBe(true);

  await ctx.close();
});

// Discord minimised to tray is its most common state, and it drops out of
// `Get-Process | Where MainWindowHandle` — while its process, and its exclusion, carry on fine.
// Treating "gone from the listing" as "gone" would tear down a working mute on a panel reopen and
// remove the row that says so, leaving the host nothing to see and nothing to undo.
test('an excluded app that drops out of the listing keeps its row and its mute', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareAndOpenSettings(page);

  await row(page, 'Discord').click();
  await captured(page).toMatchObject({ mode: 'exclude', names: ['Discord'] });

  await setApps(page, APPS.filter((a) => a.name !== 'Discord'));
  await reopenSettings(page);

  await captured(page).toMatchObject({ mode: 'exclude', names: ['Discord'] }); // nothing re-armed
  await expect(row(page, 'Discord')).toBeVisible();
  await expect(row(page, 'Discord')).toHaveAttribute('aria-pressed', 'false');
  await expect(row(page, 'Discord')).toContainText('no open window');

  await ctx.close();
});

// A restart (Discord auto-updates itself) DOES move the pid, and the session then points at a dead
// process: the mute silently stopped working. This is the one case that must re-arm — with the
// same spec, never a re-derivation.
test('a captured app that restarted under a new pid is re-armed on the next panel open', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareAndOpenSettings(page);

  await row(page, 'Discord').click();
  await captured(page).toMatchObject({ mode: 'exclude', names: ['Discord'], pids: [4001] });

  await setApps(page, APPS.map((a) => (a.name === 'Discord' ? { ...a, pid: 4009 } : a)));
  await reopenSettings(page);

  await captured(page).toMatchObject({ mode: 'exclude', names: ['Discord'], pids: [4009] });
  await expect(row(page, 'Discord')).toHaveAttribute('aria-pressed', 'false');

  await ctx.close();
});

// Inclusion freezes the set of apps it was armed with, so an app launched afterwards is silent.
// That is a real limitation, and the only acceptable version of it is one the panel shows: the new
// row renders UNTICKED, which is the truth, and ticking it is the fix.
test('an app launched after an inclusion was armed shows up unticked, and ticking it works', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareAndOpenSettings(page);

  await row(page, 'Discord').click();
  await row(page, 'Spotify').click();
  await captured(page).toMatchObject({ mode: 'include', names: ['Elden Ring'] });

  await setApps(page, [...APPS, { pid: 4100, name: 'vlc', title: 'a film' }]);
  await reopenSettings(page);

  await expect(row(page, 'vlc')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#audio-apps-hint')).toContainText('anything started later is silent');
  await captured(page).toMatchObject({ names: ['Elden Ring'] }); // nothing re-armed behind our back

  await row(page, 'vlc').click();
  await captured(page).toMatchObject({ mode: 'include', names: ['Elden Ring', 'vlc'] });

  await ctx.close();
});

// Turning system audio off must stop the native sessions — otherwise WASAPI clients keep running
// for audio no viewer receives.
test('turning system audio off releases the capture and the rows go inert', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // `audio: true`: this shares a SCREEN, so the loopback track is the one viewers get back when
  // the toggle comes on again. Without it the re-enable below finds no track, asks for one, gets
  // nothing, and turns itself off — a faithful fake failure, but not this test's subject.
  await fakeDisplayMedia(page, { audio: true });
  await fakeNative(page);
  await shareAndOpenSettings(page);

  await row(page, 'Discord').click();
  await captured(page).toMatchObject({ mode: 'exclude', names: ['Discord'] });

  await page.click('#toggle-sysaudio');
  await expect(page.locator('#toggle-sysaudio')).toHaveAttribute('aria-pressed', 'false');
  await captured(page).toBeNull();
  await expect(row(page, 'Discord')).toBeDisabled();
  await expect(page.locator('#audio-apps-hint')).toHaveText('turn system audio on to change this');
  // The ticks follow the capture rather than a remembered intent: nothing is running, so nothing
  // claims to be muted. Turning system audio back on starts from "viewers hear everything".
  await expect(row(page, 'Discord')).toHaveAttribute('aria-pressed', 'true');

  await page.click('#toggle-sysaudio');
  await expect(row(page, 'Discord')).toBeEnabled();
  await captured(page).toBeNull();
  // The capture already carries a live loopback track, so nothing is re-asked for. A second
  // getDisplayMedia here would be a whole extra screen capture — and on the web, a second prompt.
  expect(await page.evaluate(() => (window as unknown as { __gdm?: unknown[] }).__gdm?.length ?? 0)).toBe(1);

  await ctx.close();
});

// A camera is not a display surface, and `ss:select-source` only stores `screen:`/`window:` ids —
// so asking getDisplayMedia for its sound is a guaranteed refusal, and a refusal turns the toggle
// back OFF, which greys out the per-app rows. Those rows are the ONLY way a camera share ever gets
// sound (see captureCamera), so "ask anyway" trades a documented silence for a switch that cannot
// be turned on at all. Caught in review, after the re-acquire below was written without this guard.
test('a camera share never asks for a loopback track, and keeps the per-app rows reachable', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Every getDisplayMedia refused — which is exactly what main does once the pick is a camera.
  await fakeDisplayMedia(page, { rejectFrom: 0 });
  await fakeNative(page);
  await page.goto('/');
  await page.click('#btn-start');
  await expect(page.locator('#host-code')).not.toHaveText('—');
  await page.click('#btn-choose-source');
  await page.click('#btn-modal-source');
  await page.locator('#source-grid-camera button').first().click();
  await page.click('#btn-source-confirm');
  await expect(page.locator('#host-video')).toBeVisible();
  await page.click('#btn-settings');
  await expect(page.locator('#audio-apps-section')).toBeVisible();

  await page.click('#toggle-sysaudio');
  await expect(page.locator('#toggle-sysaudio')).toHaveAttribute('aria-pressed', 'false');
  await page.click('#toggle-sysaudio');
  // Still on. A grab here would have been refused and flipped it straight back off — this single
  // attribute is the whole regression.
  await expect(page.locator('#toggle-sysaudio')).toHaveAttribute('aria-pressed', 'true');
  // …and staying on is what keeps the only route to sound open.
  await expect(row(page, 'Discord')).toBeEnabled();
  await row(page, 'Discord').click();
  await captured(page).toMatchObject({ mode: 'exclude', names: ['Discord'] });

  await ctx.close();
});

test('the per-app audio section is absent in a browser', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page); // no fakeNative: a plain browser
  await page.goto('/');
  await page.click('#btn-start');
  await expect(page.locator('#host-code')).not.toHaveText('—');
  await page.click('#btn-choose-source');
  await expect(page.locator('#settings-modal')).toBeVisible();
  await expect(page.locator('#audio-apps-section')).toBeHidden();
  await ctx.close();
});
