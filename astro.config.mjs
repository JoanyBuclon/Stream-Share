// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },

  // Self-hosted Hanken Grotesk (the mockup's typeface) — downloaded + served from our origin at
  // build, so it satisfies the CSP `font-src 'self'`. Weights 600 are used by headings, hence not
  // just the 400/500 the mockup bundle embedded.
  //
  // It's a variable font: every weight resolves to the same woff2 per (subset, style), so the
  // weight list costs no bytes — only `styles` and `subsets` multiply the files. Hence `styles:
  // ['normal']`: the default is ['normal','italic'] and we use no italic anywhere, which was
  // preloading 56 KB (half the font payload) that could never be used. `latin-ext` stays: viewer
  // nicknames are user input and it covers ł/ř/ş.
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'Hanken Grotesk',
      cssVariable: '--font-hanken',
      weights: [400, 500, 600, 700],
      styles: ['normal'],
      subsets: ['latin', 'latin-ext'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
  ],
});
