# Stream Share — desktop shell (Electron)

Phase 1 "coquille": wraps the existing web build in an Electron window, adds auto-update and
a downloadable installer. No native features yet (`window.native` carries only the web origin).
See [`../docs/desktop.md`](../docs/desktop.md) for the full plan.

## How it works

- The Astro build (`../dist/`) is bundled and served over a privileged `app://` scheme
  (`src/main.ts`), so the renderer keeps a secure, non-opaque origin (required by
  getDisplayMedia / clipboard / localStorage).
- The preload (`src/preload.ts`) injects `window.native = { appOrigin }`. The shared web code
  reads it to target the real signaling server and build correct share links (it derives the
  page origin from `location` otherwise).
- **Only the front-end is bundled** (`extraResources: ../dist`). The signaling server is NOT
  embedded: the app is a client of the deployed one — `https://stream.joanybuclon.com` by
  default, overridable with `SS_APP_ORIGIN`.
- **Phase 1 forces the primary screen** as the capture source: Windows has no built-in
  `getDisplayMedia` picker (`useSystemPicker` is macOS-15+ only), so the shell must supply a
  source. The real screens/windows picker is phase 2 — see `docs/desktop.md`.
- Window close quits the app. No tray.

## Standalone sub-project

Like `signaling/`, this has its own lockfile and is **not** part of the root pnpm workspace.
Always pass `--ignore-workspace`:

```sh
pnpm install --ignore-workspace --dir electron      # install
pnpm --dir electron test                            # pure config tests (no electron needed)
pnpm --dir electron typecheck                       # tsc --noEmit

# Run it (build the web first, from the repo root — the shell serves that dist/):
pnpm build                                          # → dist/
pnpm --ignore-workspace --dir electron start        # esbuild → out/, then launch

# Point at a dev/staging origin instead of production:
SS_APP_ORIGIN=http://localhost:4321 pnpm --ignore-workspace --dir electron exec electron .

pnpm --ignore-workspace --dir electron dist         # local installer, no publish
```

Releases are built + published to GitHub Releases by CI on a `v*` tag (see
`.github/workflows/docker-publish.yml`).
