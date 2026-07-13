import { defineConfig } from '@playwright/test';

// getDisplayMedia can't show its native picker headlessly, so the test overrides it with a
// canvas stream (the WebRTC path stays real). These flags cover getUserMedia (mic) and force raw
// ICE candidates instead of mDNS `.local` ones, so two same-browser contexts connect over loopback.
const chromiumArgs = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // one host↔viewer pair at a time — they share the loopback WebRTC path
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4321',
    launchOptions: { args: chromiumArgs },
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  // Locally these reuse the already-running dev/signaling servers; in CI Playwright starts them.
  webServer: [
    {
      command: 'node signaling/src/index.js',
      port: 8080,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm exec astro dev --port 4321',
      url: 'http://localhost:4321',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
