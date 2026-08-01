import { test, expect, type Page } from '@playwright/test';
import { fakeDisplayMedia, fakeNative, fakeNotifications } from './fake-media.ts';

// Native toasts when a viewer joins or leaves. Desktop-only (window.native), and only while the
// host window is in the background. The interesting assertions are the NEGATIVE ones: which events
// deliberately stay quiet. A toast lands on a screen the whole room is watching, so every extra
// one is a real cost.

const toasts = (page: Page) =>
  expect.poll(() => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts));

/** Host a room with a live source, ready for viewers. Returns the room code. */
async function hostAShare(page: Page): Promise<string> {
  await page.goto('/');
  await page.click('#btn-start');
  await expect(page.locator('#host-code')).not.toHaveText('—');
  const code = (await page.locator('#host-code').textContent())?.trim() ?? '';
  await page.click('#btn-choose-source');
  await page.click('#btn-modal-source');
  await page.locator('#source-grid-screen button').first().click();
  await page.click('#btn-source-confirm');
  await expect(page.locator('#host-video')).toBeVisible();
  return code;
}

async function join(page: Page, code: string, pseudo: string): Promise<void> {
  await page.goto(`/#${code}`);
  await page.fill('#pseudo-input', pseudo);
  await page.click('#btn-do-join');
}

test('a viewer joining and leaving toasts once each, and a kick stays silent', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  await fakeDisplayMedia(hostPage);
  await fakeNative(hostPage);
  await fakeNotifications(hostPage, { focused: false });
  const code = await hostAShare(hostPage);

  // --- join ---
  const aCtx = await browser.newContext();
  const aPage = await aCtx.newPage();
  await join(aPage, code, 'alice');
  await expect(hostPage.locator('#viewer-count')).toHaveText('1');
  await toasts(hostPage).toEqual(['alice joined your stream']);

  // --- leave of their own accord ---
  await aCtx.close();
  await expect(hostPage.locator('#viewer-count')).toHaveText('0');
  await toasts(hostPage).toEqual(['alice joined your stream', 'alice left your stream']);

  // --- kicked: the host just did this on purpose, telling them about it is noise ---
  const bCtx = await browser.newContext();
  const bPage = await bCtx.newPage();
  await join(bPage, code, 'bob');
  await expect(hostPage.locator('#viewer-count')).toHaveText('1');
  await toasts(hostPage).toHaveLength(3);

  await hostPage.click('button[aria-label="Kick bob"]');
  await expect(hostPage.locator('#viewer-count')).toHaveText('0');
  await toasts(hostPage).toHaveLength(3); // no "bob left"

  await bCtx.close();
  await hostCtx.close();
});

test('a focused host is not told about their own room', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  await fakeDisplayMedia(hostPage);
  await fakeNative(hostPage);
  await fakeNotifications(hostPage, { focused: true });
  const code = await hostAShare(hostPage);

  const vCtx = await browser.newContext();
  const vPage = await vCtx.newPage();
  await join(vPage, code, 'carol');
  await expect(hostPage.locator('#viewer-count')).toHaveText('1'); // the join really happened
  await toasts(hostPage).toEqual([]); // it just wasn't worth interrupting for

  // Anchor the negative: an empty array is also what you get by asserting too early, so prove the
  // pipe is live by taking the focus gate away and watching the very next event come through.
  await hostPage.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });
  });
  await vCtx.close();
  await toasts(hostPage).toEqual(['carol left your stream']);

  await hostCtx.close();
});

test('the browser build never constructs a notification', async ({ browser }) => {
  // No fakeNative: a plain web page. Asking for notification permission to announce a viewer would
  // be a prompt nobody wants, so the whole path is gated on running inside the shell.
  const hostCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  await fakeDisplayMedia(hostPage);
  await fakeNotifications(hostPage, { focused: false });
  await hostPage.goto('/');
  await hostPage.click('#btn-start');
  await expect(hostPage.locator('#host-code')).not.toHaveText('—');
  const code = (await hostPage.locator('#host-code').textContent())?.trim() ?? '';
  await hostPage.click('#btn-choose-source');
  await hostPage.click('#btn-modal-source');
  await expect(hostPage.locator('#host-video')).toBeVisible();

  const vCtx = await browser.newContext();
  const vPage = await vCtx.newPage();
  await join(vPage, code, 'dave');
  await expect(hostPage.locator('#viewer-count')).toHaveText('1');
  await toasts(hostPage).toEqual([]);

  // Anchor the negative, as above: injecting window.native must be all it takes to start seeing
  // them, or this test is only proving that it polled too early.
  await hostPage.evaluate(() => {
    Object.defineProperty(window, 'native', { value: { appOrigin: location.origin }, configurable: true });
  });
  await vCtx.close();
  await toasts(hostPage).toEqual(['dave left your stream']);

  await hostCtx.close();
});
