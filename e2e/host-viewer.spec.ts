import { test, expect } from '@playwright/test';
import { fakeDisplayMedia } from './fake-media.ts';

test('host shares a source and a viewer connects to a live stream', async ({ browser }) => {
  // --- host: create a room and start sharing the (faked) source ---
  const hostCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  await fakeDisplayMedia(hostPage);
  await hostPage.goto('/');

  await hostPage.click('#btn-start');
  await expect(hostPage.locator('#host-code')).not.toHaveText('—'); // room created → code shown
  const code = (await hostPage.locator('#host-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/[A-Z0-9]/);

  // empty-state button opens the settings modal; the modal button triggers the capture
  await hostPage.click('#btn-choose-source');
  await hostPage.click('#btn-modal-source');
  await hostPage.click('#btn-settings-done'); // close the modal
  await expect(hostPage.locator('#host-video')).toBeVisible();
  await expect(hostPage.locator('#host-live-badge')).toBeVisible();

  // --- viewer: join via the share link and reach the live stream ---
  const viewerCtx = await browser.newContext();
  const viewerPage = await viewerCtx.newPage();
  await viewerPage.goto(`/#${code}`);
  await viewerPage.fill('#pseudo-input', 'e2e-viewer');
  await viewerPage.click('#btn-do-join');

  await expect(viewerPage.locator('#conn-label')).toHaveText('connected'); // direct P2P link up
  await expect(viewerPage.locator('#viewer-video')).toBeVisible();
  await expect(viewerPage.locator('#viewer-live-badge')).toBeVisible();

  // "visible" + "connected" both hold on a black or frozen stream — the checks above would pass on
  // a dead link. Assert frames actually arrive: the element decoded at least one (videoWidth > 0),
  // and the viewer's own getStats overlay reports real decoded dimensions and a live framerate
  // (frozen → 0 fps). This exercises the real inbound-rtp path, not just the UI state.
  await expect
    .poll(() => viewerPage.evaluate(() => (document.getElementById('viewer-video') as HTMLVideoElement).videoWidth))
    .toBeGreaterThan(0);
  await viewerPage.click('#btn-stats');
  await expect(viewerPage.locator('#stat-res')).toHaveText(/^\d+×\d+$/);
  await expect
    .poll(() => viewerPage.locator('#stat-fps').textContent().then((t) => parseInt(t ?? '0', 10)))
    .toBeGreaterThan(0);

  // --- host sees the viewer in its sidebar ---
  await expect(hostPage.locator('#viewer-count')).toHaveText('1');

  await hostCtx.close();
  await viewerCtx.close();
});
