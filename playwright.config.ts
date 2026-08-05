import { defineConfig, devices } from '@playwright/test';

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
    // `retain-on-failure`, not `on-first-retry`: locally `retries` is 0, so on-first-retry means no
    // trace is ever written — which is exactly what happened the one time a spec flaked here, and
    // left a DOM snapshot and nothing else to reason from. Traces are discarded on green runs, so
    // this costs the successful case nothing.
    trace: 'retain-on-failure',
  },
  projects: [
    // Desktop — the non-regression control. testIgnore keeps the touch specs out: tap() needs
    // hasTouch, which this project doesn't have.
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: /mobile\.spec\.ts/ },
    // Pixel 7 = chromium + hasTouch + isMobile + 412x915. The root `use` (baseURL, launchOptions)
    // merges in, so the fake-media flags still apply.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  // Playwright starts these; locally the astro one reuses an already-running dev server.
  webServer: [
    {
      command: 'node signaling/src/index.js',
      port: 8080,
      // The suite creates more rooms per minute from one IP than the production anti-abuse limit
      // allows, so the run must raise it — otherwise later specs fail on a missing room code and
      // look like a regression in whatever they were testing.
      env: { MAX_ROOMS_PER_MIN: '100' },
      // Never reused, unlike astro below: a signaling already started by `pnpm back` would keep
      // the default 10 and bring the flake back. Owning it here means a stray one fails loudly on
      // the port instead of quietly at the limit.
      reuseExistingServer: false,
    },
    {
      command: 'pnpm exec astro dev --port 4321',
      url: 'http://localhost:4321',
      // Reused locally, and that is a convenience with a sharp edge worth naming: this is a dev
      // server with HMR, so **saving any source file fully reloads the page under test** (measured:
      // a marker set on `window` is gone 2 s after touching src/lib/host.ts). Mid-test that looks
      // like nothing recognisable — the app reloads at `/#CODE`, routes to the JOIN screen because
      // a room code is in the hash, and whatever the test was waiting for on the host screen never
      // comes. One failure has already looked exactly like that, down to the focused nickname
      // field. If a spec fails with a join screen in its snapshot, this is the first suspect, and
      // it is not a product bug.
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
