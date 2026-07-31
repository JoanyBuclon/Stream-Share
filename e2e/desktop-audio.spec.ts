import { test, expect } from '@playwright/test';
import { fakeDisplayMedia, fakeNative } from './fake-media.ts';

// Per-app audio is desktop-only: the section stays hidden in a browser, and its markup ships in
// the web build, so stubbing window.native exercises the real wiring — everything but WASAPI.
/** Reach the settings panel with a source actually being shared: the per-app rows stay locked
 *  until there is audio to mute. On desktop "Choose source" opens OUR picker, not a prompt. */
async function shareAndOpenSettings(page: import('@playwright/test').Page): Promise<void> {
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
async function shareWindowAndOpenSettings(page: import('@playwright/test').Page, name: string): Promise<void> {
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

// The requirement this feature exists for, beyond muting: sharing a window should send THAT app's
// sound and nothing else, without the user asking.
test('sharing a window captures that app alone, and can fall back to system sound', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareWindowAndOpenSettings(page, 'Elden Ring');

  // Applied on the pick itself, with no interaction in the panel.
  expect(
    await page.evaluate(() => (window as unknown as { __audio?: { mode: string; name: string } }).__audio),
  ).toEqual({ mode: 'include', name: 'Elden Ring' });
  const only = page.locator('#audio-apps-list button', { hasText: "Only Elden Ring's sound" });
  await expect(only).toHaveAttribute('aria-pressed', 'true');

  // Fall back to the full system mix, which is where muting becomes meaningful again.
  await page.locator('#audio-apps-list button', { hasText: 'No app muted' }).click();
  expect(await page.evaluate(() => (window as unknown as { __audio?: unknown }).__audio)).toBeNull();
  await expect(only).toHaveAttribute('aria-pressed', 'false');

  // And back again — the row survives the round trip, so the choice is reversible.
  await only.click();
  await expect(only).toHaveAttribute('aria-pressed', 'true');

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

  expect(await page.evaluate(() => (window as unknown as { __audio?: unknown }).__audio)).toBeNull();
  await expect(page.locator('#audio-apps-hint')).toContainText('no app audio of its own');
  await expect(page.locator('#audio-apps-list button', { hasText: 'No app muted' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await ctx.close();
});

// A screen has no owning app: the include row must not be offered at all.
test('sharing a screen offers no app-alone row', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareAndOpenSettings(page);
  await expect(page.locator('#audio-apps-list button', { hasText: "sound" })).toHaveCount(0);
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

test('muting one app is single-select and reversible', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareAndOpenSettings(page);

  const list = page.locator('#audio-apps-list');
  await expect(page.locator('#audio-apps-section')).toBeVisible();
  await expect(list.locator('button')).toHaveCount(4); // "no app" + the three stubbed apps

  const none = list.locator('button', { hasText: 'No app muted' });
  const discord = list.locator('button', { hasText: 'Discord' });
  const spotify = list.locator('button', { hasText: 'Spotify' });
  await expect(none).toHaveAttribute('aria-pressed', 'true'); // nothing muted by default

  await discord.click();
  await expect(discord).toHaveAttribute('aria-pressed', 'true');
  await expect(none).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => (window as unknown as { __audio?: { name: string } }).__audio?.name)).toBe('Discord');

  // Single-select: picking another app replaces the first, it does not add to it.
  await spotify.click();
  await expect(spotify).toHaveAttribute('aria-pressed', 'true');
  await expect(discord).toHaveAttribute('aria-pressed', 'false');

  await none.click();
  await expect(none).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as unknown as { __audio?: unknown }).__audio)).toBeNull();

  await ctx.close();
});

// An app that quit between the listing and the click: the shell can't find it and answers null.
// The panel must not go on claiming it is muted — that is the state where a host believes their
// voice chat is silenced and it is not.
test('an app that vanished before the click is not shown as muted', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareAndOpenSettings(page);

  const ghost = page.locator('#audio-apps-list button', { hasText: 'Ghost' });
  await ghost.click();
  await expect(ghost).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#audio-apps-list button', { hasText: 'No app muted' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await ctx.close();
});

// Turning system audio off while an app is muted must stop the native capture too — otherwise a
// WASAPI client keeps running for audio no viewer receives.
test('turning system audio off releases the exclusion', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await shareAndOpenSettings(page);

  await page.locator('#audio-apps-list button', { hasText: 'Discord' }).click();
  expect(await page.evaluate(() => (window as unknown as { __audio?: { name: string } }).__audio?.name)).toBe('Discord');

  await page.click('#toggle-sysaudio'); // system audio on → off
  await expect(page.locator('#toggle-sysaudio')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => (window as unknown as { __audio?: unknown }).__audio)).toBeNull();
  await expect(page.locator('#audio-apps-list button', { hasText: 'Discord' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await ctx.close();
});
