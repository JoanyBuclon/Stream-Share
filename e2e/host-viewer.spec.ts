import { test, expect, type Page } from '@playwright/test';

// Replace the native screen-picker with a synthetic animated canvas stream, so the whole WebRTC
// path runs for real (RTCPeerConnection, ICE, encode) but headless and without a user gesture.
async function fakeDisplayMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      let hue = 0;
      setInterval(() => {
        if (!ctx) return;
        hue = (hue + 8) % 360;
        ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }, 66); // keep painting so the encoder has fresh frames
      return canvas.captureStream(15);
    };
  });
}

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
