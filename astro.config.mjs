// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
    // Keep the dev server's watcher out of the desktop build outputs. Not tidiness — it is what
    // makes `pnpm dist` fail. Vite watches the whole project with chokidar, which opens a directory
    // handle per directory as they appear; electron-builder extracts Electron into
    // `electron/release/win-unpacked.tmp` and then RENAMES that directory, and on Windows a rename
    // fails with EPERM while anyone holds a handle to it. Measured: identical pack, dev server up →
    // `EPERM … rename 'win-unpacked.tmp' -> 'win-unpacked'`; dev server down → exit 0. Nothing to do
    // with the H: drive or with Defender, which is what this was blamed on for days.
    // Merged with Vite's own defaults (node_modules, .git), not replacing them.
    server: { watch: { ignored: ['**/electron/release/**', '**/electron/release', '**/electron/out/**'] } },
  },

  // Self-hosted Hanken Grotesk (the mockup's typeface) — downloaded + served from our origin at
  // build, so it satisfies the CSP `font-src 'self'`. Weights 600 are used by headings, hence not
  // just the 400/500 the mockup bundle embedded.
  //
  // It's a variable font: every weight resolves to the same woff2 per (subset, style), so the
  // weight list costs no bytes — only `styles` and `subsets` multiply the files. Hence `styles:
  // ['normal']`: the default is ['normal','italic'] and we use no italic anywhere, which was
  // preloading 56 KB (half the font payload) that could never be used.
  //
  // `latin` only: `<Font preload />` emits a `rel=preload` per generated file at Highest priority,
  // and latin-ext (19.6 KB, 25% of the first load) held glyphs the ASCII landing screen never
  // paints. A ł/ř/ş nickname now falls to the fallback face — which Astro generates with matched
  // metrics (size-adjust/ascent-override), so no layout shift.
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'Hanken Grotesk',
      cssVariable: '--font-hanken',
      weights: [400, 500, 600, 700],
      styles: ['normal'],
      subsets: ['latin'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
  ],
});
