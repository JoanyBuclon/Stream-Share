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
    // .cjs is CommonJS by definition — the tools/ harnesses loaded by Electron's main process, the
    // electron-builder hooks. `require` there is the module system, not a style.
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Browser lib (WebRTC/WebSocket) + Node signaling + node:test — allow both global sets.
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // The relay/peer code deliberately swallows errors on closed sockets/peers.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
