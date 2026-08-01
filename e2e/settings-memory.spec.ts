import { test, expect, type Page } from '@playwright/test';
import { fakeDisplayMedia, fakeNative } from './fake-media.ts';

// Remembered settings. Every change repaints the panel and the repaint writes localStorage, which
// is read back when the next HostController is built — so a reload is the whole test. No stubbing:
// this is the real path in a real browser. Storage is per-context and every spec makes its own, so
// runs cannot leak into one another.

/** Open a room and reach the settings panel with a source live. */
async function openSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.click('#btn-start');
  await expect(page.locator('#host-code')).not.toHaveText('—');
  await page.click('#btn-choose-source');
  await expect(page.locator('#settings-modal')).toBeVisible();
}

const active = (page: Page, attr: string, value: string) =>
  page.locator(`#settings-modal [data-${attr}="${value}"]`);

/** Reload for real, then get back into the settings panel. The `goto` is not redundant: creating a
 *  room rewrites the URL to `/#CODE`, so a bare reload would come back on the join screen with
 *  #btn-start hidden. */
async function restartAndOpenSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.reload();
  await page.click('#btn-start');
  await expect(page.locator('#host-code')).not.toHaveText('—');
  await page.click('#btn-choose-source');
  await expect(page.locator('#settings-modal')).toBeVisible();
}

test('quality settings survive a reload, and the mic never does', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await openSettings(page);

  // Defaults, so the assertions after the reload mean something.
  await expect(active(page, 'preset', 'gaming')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');

  await active(page, 'res', '1080').click();
  await active(page, 'fps', '30').click();
  await page.locator('#bitrate-range').fill('7'); // fill() already dispatches input AND change
  await page.click('#toggle-sysaudio'); // on → off
  await page.click('#toggle-mic'); // off → ON: deliberately not persisted
  await expect(page.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'true');
  await page.click('#btn-settings-done');

  await restartAndOpenSettings(page);

  await expect(active(page, 'res', '1080')).toHaveAttribute('aria-pressed', 'true');
  await expect(active(page, 'fps', '30')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#bitrate-value')).toHaveText('7 mbps');
  await expect(page.locator('#toggle-sysaudio')).toHaveAttribute('aria-pressed', 'false');
  // Picking a tier by hand clears the preset, and that is remembered too.
  await expect(active(page, 'preset', 'gaming')).toHaveAttribute('aria-pressed', 'false');
  // The one field that is never restored: a microphone that turns itself back on is a surprise
  // nobody asked for, and it would light the OS indicator before anyone has even joined.
  await expect(page.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');

  await ctx.close();
});

// Escape used to bypass closeSettings entirely — the button handler was the only path in — so the
// panel's cleanup never ran and the per-app rows stayed in the DOM between openings. Those rows
// carry window TITLES: documents, chat subjects, on a machine whose screen is being shared. The
// listener now hangs off the dialog's native `close`, which Escape does fire.
//
// This has to assert the cleanup, not the save: the settings are written by the repaint on every
// click, so any assertion about persistence here would pass with the whole listener deleted.
test('closing with Escape runs the panel cleanup, not just the buttons', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page); // the per-app rows are desktop-only
  await page.goto('/');
  await page.click('#btn-start');
  await expect(page.locator('#host-code')).not.toHaveText('—');
  await page.click('#btn-choose-source');
  await page.click('#btn-modal-source');
  await page.locator('#source-grid-screen button').first().click();
  await page.click('#btn-source-confirm');
  await expect(page.locator('#host-video')).toBeVisible();

  await page.click('#btn-settings');
  await expect(page.locator('#audio-apps-list button').first()).toBeVisible(); // titles are in the DOM

  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-modal')).toBeHidden();
  await expect(page.locator('#audio-apps-list button')).toHaveCount(0); // …and gone again

  await ctx.close();
});

// The regression that persistence would otherwise introduce. clampResolution lowers the cap to fit
// the source — the fake capture is 360p, so it drops to 480 — and a desktop host mostly shares
// windows, which are never 2160 tall. Persisting the clamped value would pin the cap low for every
// later session, on any screen, with nothing on screen to explain it.
test('a resolution clamped to fit the source is not what gets remembered', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await openSettings(page);

  await active(page, 'res', '2160').click();
  // Capture is 640×360, so the cap clamps down to 480. In a browser the panel stays open behind
  // the (faked) prompt, so there is nothing to reopen.
  await page.click('#btn-modal-source');
  await expect(page.locator('#host-video')).toBeVisible();
  await expect(active(page, 'res', '480')).toHaveAttribute('aria-pressed', 'true'); // clamped, as designed
  // Touch something else: the save writes the whole object, which is exactly how a clamped value
  // would sneak in.
  await page.locator('#bitrate-range').fill('11');
  await page.click('#btn-settings-done');

  await restartAndOpenSettings(page);
  await expect(page.locator('#bitrate-value')).toHaveText('11 mbps'); // the edit landed
  await expect(active(page, 'res', '2160')).toHaveAttribute('aria-pressed', 'true'); // the ask, not the clamp

  await ctx.close();
});

// The cap has to be DERIVED from the ask each time, not stepped down in place. The old code
// compared against the already-clamped value, so it could only ever lower: share a small window,
// switch to a 4K screen, and the host went on sending 480p with nothing on screen to explain it —
// while the stored setting, being the un-clamped ask, was more correct than the live one.
test('the cap recovers when a bigger source replaces a small one', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page, {
    sizes: [
      [640, 360], // a small window: 4K is unreachable, the cap drops to 480
      [3840, 2160], // then the whole screen: the original ask must come back
    ],
  });
  await openSettings(page);

  await page.click('#btn-modal-source');
  await expect(page.locator('#host-video')).toBeVisible();
  await expect(active(page, 'res', '480')).toHaveAttribute('aria-pressed', 'true');

  await page.click('#btn-modal-source'); // switch source, same room
  await expect(active(page, 'res', '2160')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#est-res')).toHaveText('4K');

  await ctx.close();
});

// Valid JSON with ONE bad field, deliberately: unparseable input only exercises the try/catch, and
// this test would then pass against `{ ...DEFAULT_QUALITY, ...JSON.parse(raw) }` with no validation
// at all. What has to hold is that the bad field alone falls back — that is the whole reason the
// parse is per-field, so that a schema change in a self-updating app costs one setting, not all.
test('a store written by another version loses only the field that no longer fits', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await page.goto('/');
  await page.evaluate(() =>
    localStorage.setItem('ss-quality', '{"fps":"fast","bitrate":11,"resolution":720,"preset":null}'),
  );
  await restartAndOpenSettings(page);
  await expect(active(page, 'fps', '60')).toHaveAttribute('aria-pressed', 'true'); // the bad one
  await expect(page.locator('#bitrate-value')).toHaveText('11 mbps'); // the good ones survive
  await expect(active(page, 'res', '720')).toHaveAttribute('aria-pressed', 'true');

  await ctx.close();
});

test('an unparseable store falls back whole instead of breaking the panel', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('ss-quality', '{"fps":"fast","bitrate":'));
  await restartAndOpenSettings(page);
  await expect(active(page, 'fps', '60')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#bitrate-value')).toHaveText('20 mbps');

  await ctx.close();
});
