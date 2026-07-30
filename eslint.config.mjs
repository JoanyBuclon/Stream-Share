import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import globals from 'globals';

export default [
  { ignores: ['dist/', '.astro/', '**/node_modules/', 'electron/out/', 'electron/release/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  {
    // Browser lib (WebRTC/WebSocket) + Node signaling + node:test — allow both global sets.
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // The relay/peer code deliberately swallows errors on closed sockets/peers.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
