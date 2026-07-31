import { test, expect, type Page } from '@playwright/test';
import { fakeDisplayMedia, fakeNative } from './fake-media.ts';

// The desktop source picker (src/lib/source-picker.ts) only opens when window.native exists, so
// it can never be reached by the browser specs. Its markup ships in the web build though, so
// stubbing the shell's two IPC methods exercises the real dialog, the real filtering and the real
// confirm path — everything except Electron itself.

/** Open a room and reach the picker: empty stage → settings → "Choose source". */
async function openPicker(page: Page): Promise<void> {
  await page.goto('/');
  await page.click('#btn-start');
  await expect(page.locator('#host-code')).not.toHaveText('—');
  await page.click('#btn-choose-source');
  await page.click('#btn-modal-source');
}

test('the picker lists screens and windows, filters them, and shares the one picked', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);
  await openPicker(page);

  // Grouped by kind, with live counts, and the settings panel it replaced is gone.
  await expect(page.locator('#source-modal')).toBeVisible();
  await expect(page.locator('#settings-modal')).toBeHidden();
  await expect(page.locator('#source-count-screen')).toHaveText('2 available');
  await expect(page.locator('#source-count-window')).toHaveText('2 available');
  await expect(page.locator('#source-status')).toBeHidden();

  // Search filters in place and empties whole groups; the count follows.
  await page.fill('#source-search', 'disc');
  await expect(page.locator('#source-group-screen')).toBeHidden();
  await expect(page.locator('#source-count-window')).toHaveText('1 available');
  await page.fill('#source-search', 'zzz');
  await expect(page.locator('#source-status')).toHaveText('no screen or app matches that search');
  await page.fill('#source-search', '');
  await expect(page.locator('#source-status')).toBeHidden();

  // Nothing is selected on open, so there is nothing to confirm yet.
  await expect(page.locator('#btn-source-confirm')).toBeDisabled();

  const discord = page.locator('#source-grid-window button', { hasText: 'Discord' });
  await discord.click();
  await expect(discord).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#source-selection')).toHaveText('Discord');
  await page.click('#btn-source-confirm');

  // Confirmed: the shell was told which source, the dialog closed, the stream is live.
  await expect(page.locator('#source-modal')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __picked?: string }).__picked)).toBe('window:12:0');
  await expect(page.locator('#host-video')).toBeVisible();
  await expect(page.locator('#host-live-badge')).toBeVisible();

  // Reopening preselects what is being shared.
  await page.click('#btn-settings');
  await page.click('#btn-modal-source');
  await expect(page.locator('#source-grid-window button', { hasText: 'Discord' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await ctx.close();
});

// Regression: `load()` used to guard on `modal.open`, which is shared DOM state — it answers "is
// *a* picker open", not "is mine". Dismissing during the listing and reopening let the first call
// repaint the second dialog with tiles whose click listeners were bound to an already-aborted
// signal, i.e. a full grid where nothing is clickable and confirm is enabled but does nothing.
//
// The delays are the whole test: the first call must resolve AFTER the second, or the second
// simply overwrites the stale tiles and the bug hides.
test('a listing from a dismissed picker cannot repaint the next one with dead tiles', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page, { delaysMs: [4000, 50] });
  await openPicker(page);

  await expect(page.locator('#source-status')).toHaveText('loading sources…');
  await page.click('#btn-source-close'); // close while the first listSources is still in flight
  await expect(page.locator('#source-modal')).toBeHidden();

  await page.click('#btn-modal-source'); // cancelling put the settings panel back
  await expect(page.locator('#source-modal')).toBeVisible();
  const screen1 = page.locator('#source-grid-screen button', { hasText: 'Screen 1' });
  await expect(screen1).toBeVisible({ timeout: 5000 });
  // Wait for the ABANDONED listing to land, not for a duration: a plain timeout races against
  // Playwright's ~1 s click latency and silently stops testing anything.
  await page.waitForFunction(() => (window as unknown as { __listed?: number[] }).__listed?.includes(0), null, {
    timeout: 10_000,
  });

  await screen1.click();
  await expect(page.locator('#btn-source-confirm')).toBeEnabled();
  await expect(page.locator('#source-selection')).toHaveText('Screen 1 · 2560×1440');
  await page.click('#btn-source-confirm');
  await expect(page.locator('#host-video')).toBeVisible();

  await ctx.close();
});

// The picker deliberately does NOT fall back to a shell-chosen source when listing fails: that
// would share something the user never picked. So the message it shows instead is the whole
// recovery path, and it must survive a keystroke.
test('a failed listing keeps an honest message instead of falling back to a capture', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page, { fail: true });
  await openPicker(page);

  await expect(page.locator('#source-status')).toHaveText('could not list sources — close and try again');
  await expect(page.locator('#source-search')).toBeDisabled(); // else typing rewrites it as "no match"
  await expect(page.locator('#btn-source-confirm')).toBeDisabled();
  await expect(page.locator('#host-video')).toBeHidden(); // nothing captured behind our back

  await page.keyboard.press('Escape');
  await expect(page.locator('#source-modal')).toBeHidden();
  await expect(page.locator('#host-empty')).toBeVisible();

  await ctx.close();
});
