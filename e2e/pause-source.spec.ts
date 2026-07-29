import { test, expect } from '@playwright/test';
import { fakeDisplayMedia } from './fake-media.ts';

// Assert a real video track is attached AND decoding frames (videoWidth only turns > 0 on the first
// rendered frame — a black/frozen stream never reaches it). Shared by both scenarios below.
async function expectDecodingVideo(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const v = document.getElementById('viewer-video') as HTMLVideoElement;
          const stream = v.srcObject as MediaStream | null;
          return { videoTracks: stream?.getVideoTracks().length ?? 0, decoded: v.videoWidth > 0 };
        }),
      { timeout: 15_000 },
    )
    .toEqual({ videoTracks: 1, decoded: true });
}

// Bug 1: a viewer joining BEFORE the host has picked any source used to hang on "connecting"
// forever (the host never offered without an outgoing stream). It must land on the paused (waiting)
// screen, then go live once the host picks a source — without the viewer rejoining.
test('a viewer who joins before any source is chosen waits on the paused screen, then goes live', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  await fakeDisplayMedia(hostPage);
  await hostPage.goto('/');

  await hostPage.click('#btn-start');
  await expect(hostPage.locator('#host-code')).not.toHaveText('—');
  const code = (await hostPage.locator('#host-code').textContent())?.trim() ?? '';

  // --- viewer joins while the host is still on the empty "choose source" state ---
  const viewerCtx = await browser.newContext();
  const viewerPage = await viewerCtx.newPage();
  await viewerPage.goto(`/#${code}`);
  await viewerPage.fill('#pseudo-input', 'e2e-early');
  await viewerPage.click('#btn-do-join');
  await expect(viewerPage.locator('#conn-label')).toHaveText('paused'); // not stuck on "connecting…"
  await expect(viewerPage.locator('#viewer-paused')).toBeVisible();

  // --- host finally picks a source: the waiting viewer goes live, no rejoin ---
  await hostPage.click('#btn-choose-source');
  await hostPage.click('#btn-modal-source');
  await hostPage.click('#btn-settings-done');
  await expect(viewerPage.locator('#conn-label')).toHaveText('connected');
  await expect(viewerPage.locator('#viewer-video')).toBeVisible();
  await expectDecodingVideo(viewerPage);

  await hostCtx.close();
  await viewerCtx.close();
});

// Bug 2/3: stopping the source (Stop button, or the browser's "Stop sharing" chrome → track `ended`)
// used to tear the room down — host back home, viewer on "The host stopped sharing". It must instead
// cut only the source: the room + peers stay, the host returns to "choose source", the viewer sees
// the paused screen, and picking a new source brings everyone back live.
test('stopping the source keeps the room: viewer pauses, host re-picks a source, stream resumes', async ({ browser }) => {
  const hostCtx = await browser.newContext();
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

  const viewerCtx = await browser.newContext();
  const viewerPage = await viewerCtx.newPage();
  await viewerPage.goto(`/#${code}`);
  await viewerPage.fill('#pseudo-input', 'e2e-watcher');
  await viewerPage.click('#btn-do-join');
  await expect(viewerPage.locator('#conn-label')).toHaveText('connected');
  await expectDecodingVideo(viewerPage);

  // --- host stops the source ---
  await hostPage.click('#btn-stop');
  // host: back to the empty "choose source" state, NOT the home screen; the room stays open
  await expect(hostPage.locator('#host-empty')).toBeVisible();
  await expect(hostPage.locator('#screen-host')).toBeVisible();
  await expect(hostPage.locator('#viewer-count')).toHaveText('1'); // the viewer is still in the room
  // viewer: paused (waiting), NOT "The host stopped sharing"
  await expect(viewerPage.locator('#conn-label')).toHaveText('paused');
  await expect(viewerPage.locator('#viewer-paused')).toBeVisible();
  await expect(viewerPage.locator('#viewer-ended')).toBeHidden();

  // --- host picks a new source: the same viewer resumes live, no rejoin ---
  await hostPage.click('#btn-choose-source');
  await hostPage.click('#btn-modal-source');
  await hostPage.click('#btn-settings-done');
  await expect(viewerPage.locator('#conn-label')).toHaveText('connected');
  await expectDecodingVideo(viewerPage);

  await hostCtx.close();
  await viewerCtx.close();
});
