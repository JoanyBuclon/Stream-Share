import { test, expect, type Page } from '@playwright/test';
import { fakeDisplayMedia, fakeNative } from './fake-media.ts';

// The desktop shell holds the display awake with a process-level powerSaveBlocker instead of the
// renderer's navigator.wakeLock, which is released the moment the window is hidden. What can be
// checked from a page is the handshake: that a session asks for it, and — the part that actually
// bites — that ending the session gives it back. A blocker left running keeps the machine awake
// with no UI anywhere that would ever reveal it.

const wakeLock = (page: Page) =>
  expect.poll(() => page.evaluate(() => (window as unknown as { __wakeLock?: boolean[] }).__wakeLock));

/** Whether the shell is currently asked to hold the display awake — the LAST toggle, not the whole
 *  list. Leaving a room tears the controller down along a path that can release twice (leave() then
 *  goHome()'s teardown), which main collapses on its own id; pinning the exact sequence would be
 *  asserting that implementation detail rather than the thing that matters, which is what the state
 *  settles on. */
const held = (page: Page) =>
  expect.poll(() => page.evaluate(() => (window as unknown as { __wakeLock?: boolean[] }).__wakeLock?.at(-1)));

test('hosting takes the wake lock and leaving the room gives it back', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await fakeDisplayMedia(page);
  await fakeNative(page);

  await page.goto('/');
  await wakeLock(page).toBeUndefined(); // nothing held just for sitting on the landing page

  await page.click('#btn-start');
  await expect(page.locator('#host-code')).not.toHaveText('—');
  await wakeLock(page).toEqual([true]);

  await page.click('#brand-host'); // the brand logo leaves the room (the host screen's own copy)
  await expect(page.locator('#screen-home')).toBeVisible();
  await held(page).toBe(false);

  await ctx.close();
});

test('watching takes it too, and stops on leave', async ({ browser }) => {
  // Same two lines in viewer.ts, but through the same factory — worth one pass so a future
  // refactor cannot quietly leave the viewer on the browser sentinel.
  const hostCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  await fakeDisplayMedia(hostPage);
  await hostPage.goto('/');
  await hostPage.click('#btn-start');
  await expect(hostPage.locator('#host-code')).not.toHaveText('—');
  const code = (await hostPage.locator('#host-code').textContent())?.trim() ?? '';
  await hostPage.click('#btn-choose-source');
  await hostPage.click('#btn-modal-source');
  await expect(hostPage.locator('#host-video')).toBeVisible();

  const viewerCtx = await browser.newContext();
  const viewerPage = await viewerCtx.newPage();
  await fakeNative(viewerPage); // a viewer running inside the desktop shell
  await viewerPage.goto(`/#${code}`);
  await viewerPage.fill('#pseudo-input', 'e2e-viewer');
  await viewerPage.click('#btn-do-join');
  await expect(viewerPage.locator('#viewer-video')).toBeVisible();
  await wakeLock(viewerPage).toEqual([true]);

  await viewerPage.click('#btn-leave');
  await expect(viewerPage.locator('#screen-home')).toBeVisible();
  await held(viewerPage).toBe(false);

  await viewerCtx.close();
  await hostCtx.close();
});

// The leak this feature introduced, and the one that matters most. A viewer reaches a terminal
// screen WITHOUT ever calling destroy() — that only runs on a click — so the host stopping the
// share leaves them on "ended" with the lock still held. Under the web sentinel that was harmless:
// hiding the window released it. The shell's blocker is built not to be released that way, which
// is exactly what turns a dormant bug into a machine that never sleeps again.
test('a viewer left on the ended screen does not keep holding it', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  await fakeDisplayMedia(hostPage);
  await hostPage.goto('/');
  await hostPage.click('#btn-start');
  await expect(hostPage.locator('#host-code')).not.toHaveText('—');
  const code = (await hostPage.locator('#host-code').textContent())?.trim() ?? '';
  await hostPage.click('#btn-choose-source');
  await hostPage.click('#btn-modal-source');
  await expect(hostPage.locator('#host-video')).toBeVisible();
  await hostPage.click('#btn-settings-done'); // in a browser the panel stays open over the brand link

  const viewerCtx = await browser.newContext();
  const viewerPage = await viewerCtx.newPage();
  await fakeNative(viewerPage);
  await viewerPage.goto(`/#${code}`);
  await viewerPage.fill('#pseudo-input', 'e2e-viewer');
  await viewerPage.click('#btn-do-join');
  await expect(viewerPage.locator('#viewer-video')).toBeVisible();
  await held(viewerPage).toBe(true);

  // The host leaves for good. Not `hostCtx.close()`: dropping the socket only starts the reclaim
  // grace window, so the room stays alive and the viewer never reaches a terminal screen.
  await hostPage.click('#brand-host');
  await expect(viewerPage.locator('#viewer-ended')).toBeVisible();
  // The viewer has clicked nothing — destroy() has not run, and must not be what frees this.
  await held(viewerPage).toBe(false);

  await viewerCtx.close();
  await hostCtx.close();
});
