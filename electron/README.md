# StreamShare — desktop shell (Electron)

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

## Icon

`build/icon.png` (512×512, the `public/favicon.svg` mark on an ink background). `build/` is
electron-builder's default `buildResources` directory, so the icon is picked up with no config
entry; it converts the PNG to `.ico` for the window and the NSIS installer.

## electron-builder must stay ≥ 26.12

On 25.x the installer **dies the moment you double-click it** — no window, no error:
`0xc0000005` in `%TEMP%\nspXXXX.tmp\System.dll`, fault offset `0x1581`.

It is **not** the bundled NSIS (25.x and 26.x both ship NSIS 3.04). The bug is in
electron-builder's own `multiUser.nsh` template: `setInstallModePerUser` reads
`NSIS_MAX_STRLEN` (8192 wide chars = 16 KB) out of the ~60-byte `CoTaskMemAlloc` buffer returned
by `SHGetKnownFolderPath`, in vestigial Windows 7 support. Whether that over-read hits an
unmapped page depends on heap layout — hence "random" for some, always for others.

**It only triggers on our exact config**: `oneClick: false` + `perMachine: false` + no prior
per-user install. Fixed properly in **app-builder-lib 26.12.0** ([PR #9769]; 26.9.0 only fixed it
on Win 8+). Reproduced here with both a CI-built and a locally built installer at the same fault
offset, and confirmed fixed on 26.15.3.

[PR #9769]: https://github.com/electron-userland/electron-builder/pull/9769

```
// ponytail: don't pin electron-builder below 26.12 — the installer silently stops launching.
// Workarounds exist (oneClick: true, selectPerMachineByDefault: true) but both change the UX;
// the version bump is the fix. See electron-builder issue #8536.
```

## Why installs pass `--ignore-scripts`

electron-builder 26 depends on `electron-winstaller` (Squirrel target, unused here), whose install
script pnpm refuses to run for the same reason as esbuild below — so the install *errors out*.
Nothing in this project needs a lifecycle script: Electron downloads its binary on first run, and
electron-builder fetches its own toolchain at build time. A `.npmrc` with `ignore-scripts=true`
does **not** work: pnpm still raises `ERR_PNPM_IGNORED_BUILDS`; only the CLI flag suppresses it.

## Why `esbuild-wasm` and not `esbuild`

`esbuild` ships a native binary installed by a lifecycle script. pnpm 11 blocks those unless the
package is listed under `allowBuilds`, which it reads **only** from `pnpm-workspace.yaml` — and
this project is installed with `--ignore-workspace`, so neither the root file nor a local one is
read (`package.json` settings aren't honoured either). CI would then fail with
`ERR_PNPM_IGNORED_BUILDS`. `esbuild-wasm` is pure JS/WASM with no lifecycle script, same CLI:
building these two files takes ~150 ms instead of ~10 ms, which is irrelevant here.

```
// ponytail: don't "upgrade" back to native esbuild — it re-breaks the CI install.
```

## Standalone sub-project

Like `signaling/`, this has its own lockfile and is **not** part of the root pnpm workspace.
Always pass `--ignore-workspace`:

```sh
pnpm install --ignore-workspace --ignore-scripts --dir electron   # install
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
