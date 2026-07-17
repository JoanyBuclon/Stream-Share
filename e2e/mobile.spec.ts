import { test, expect } from '@playwright/test';
import { fakeDisplayMedia } from './fake-media.ts';

// Runs under the `mobile` project (Pixel 7: hasTouch + 412x915). The host still needs a desktop
// context — hosting from a phone is exactly what the gate below forbids — so only the viewer is
// touch-driven here.

test('a viewer on a touch device can toggle the controls and leave', async ({ browser }) => {
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const hostPage = await hostCtx.newPage();
  await fakeDisplayMedia(hostPage);
  await hostPage.goto('/');

  await hostPage.click('#btn-start');
  await expect(hostPage.locator('#host-code')).not.toHaveText('—');
  const code = (await hostPage.locator('#host-code').textContent())?.trim() ?? '';
  await hostPage.click('#btn-choose-source');
  await hostPage.click('#btn-modal-source');
  await hostPage.click('#btn-settings-done');
  await expect(hostPage.locator('#host-live-badge')).toBeVisible();

  // --- viewer: the touch context under test ---
  const viewerPage = await browser.newPage();
  await viewerPage.goto(`/#${code}`);
  await viewerPage.fill('#pseudo-input', 'e2e-mobile');
  await viewerPage.click('#btn-do-join');
  await expect(viewerPage.locator('#conn-label')).toHaveText('connected');
  await expect(viewerPage.locator('#viewer-controls')).toHaveCSS('opacity', '1');

  // The assertion that catches the bug: a tap dismisses the UI *immediately*. The 1s window is the
  // whole point — it must be under UI_IDLE_MS (3s), or the old mousemove-only wiring passes by
  // simply idling out, which is what a default 15s retry window would have let it do.
  await viewerPage.tap('#viewer-video');
  await expect(viewerPage.locator('#viewer-controls')).toHaveCSS('opacity', '0', { timeout: 1_000 });

  // ...and back in one tap, actually interactive again (pointer-events restored, not just opacity).
  await viewerPage.tap('#viewer-video');
  await expect(viewerPage.locator('#viewer-controls')).toHaveCSS('opacity', '1');
  await viewerPage.tap('#btn-leave');
  await expect(viewerPage.locator('#screen-home')).toBeVisible();

  await hostCtx.close();
  await viewerPage.close();
});

test('start a share is disabled when the browser has no getDisplayMedia', async ({ page }) => {
  // Pixel 7 emulation is desktop Chromium with a mobile UA/viewport, so getDisplayMedia IS defined
  // and the gate would never fire. Delete it to get a real mobile browser's capability surface —
  // off the prototype, where it actually lives; navigator.mediaDevices has no own property to drop.
  await page.addInitScript(() => {
    Reflect.deleteProperty(MediaDevices.prototype, 'getDisplayMedia');
  });
  await page.goto('/');

  await expect(page.locator('#btn-start')).toBeDisabled();
  await expect(page.locator('#start-unsupported')).toBeVisible();
  // joining is the whole point of mobile — it must stay wired
  await expect(page.locator('#join-input')).toBeEnabled();
});
