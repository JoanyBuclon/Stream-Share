import { test, expect } from '@playwright/test';
import { fakeDisplayMedia } from './fake-media.ts';

// Régression : un viewer qui rejoint PENDANT une pause restait noir, même après la reprise.
// Le chemin est spécifique — l'offre est construite alors que `outgoing` n'a pas de piste vidéo,
// donc le m-line vidéo part sans association de flux, et la vidéo n'atteint jamais le <video>.
test('a viewer joining while the host is paused gets the video once resumed', async ({ browser }) => {
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

  // --- pause AVANT que le viewer arrive : c'est tout l'intérêt du test ---
  await hostPage.click('#btn-pause');
  await expect(hostPage.locator('#host-paused-badge')).toBeVisible();

  const viewerCtx = await browser.newContext();
  const viewerPage = await viewerCtx.newPage();
  await viewerPage.goto(`/#${code}`);
  await viewerPage.fill('#pseudo-input', 'e2e-late');
  await viewerPage.click('#btn-do-join');
  await expect(viewerPage.locator('#conn-label')).toHaveText('paused');

  // --- reprise : la vidéo doit arriver ---
  await hostPage.click('#btn-resume');
  await expect(viewerPage.locator('#conn-label')).toHaveText('connected');
  await expect(viewerPage.locator('#viewer-video')).toBeVisible();

  // toBeVisible() ne prouve rien ici : l'élément était visible ET noir. Ce qui compte, c'est
  // qu'une piste vidéo soit réellement attachée et que des frames soient décodées.
  // Une piste attachée ne suffit pas : il faut qu'elle DÉCODE. `videoWidth > 0` ne devient vrai
  // qu'au premier frame réellement rendu, ce que l'écran noir n'atteignait jamais.
  await expect
    .poll(
      () =>
        viewerPage.evaluate(() => {
          const v = document.getElementById('viewer-video') as HTMLVideoElement;
          const stream = v.srcObject as MediaStream | null;
          return { videoTracks: stream?.getVideoTracks().length ?? 0, decoded: v.videoWidth > 0 };
        }),
      { timeout: 15_000 },
    )
    .toEqual({ videoTracks: 1, decoded: true });

  await hostCtx.close();
  await viewerCtx.close();
});
