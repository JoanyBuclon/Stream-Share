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

  // --- host sees the viewer in its sidebar ---
  await expect(hostPage.locator('#viewer-count')).toHaveText('1');

  await hostCtx.close();
  await viewerCtx.close();
});
