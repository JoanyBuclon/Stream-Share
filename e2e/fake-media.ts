import { type Page } from '@playwright/test';

// Replace the native screen-picker with a synthetic animated canvas stream, so the whole WebRTC
// path runs for real (RTCPeerConnection, ICE, encode) but headless and without a user gesture.
// Lives outside the specs because Playwright forbids importing one test file from another.
export async function fakeDisplayMedia(page: Page): Promise<void> {
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
