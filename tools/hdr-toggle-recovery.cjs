// Does a MONITOR capture survive HDR being switched off — and can it be brought back?
//
// The automatic-recovery feature rests on three claims that nothing in this repo measures.
// `addon.cc` asserts the first in a comment; `tools/window-hdr-probe.cjs` measured the equivalent
// for a WINDOW being destroyed, which is a different event with a different answer.
//
//   1. `GraphicsCaptureItem::Closed` fires for a monitor item when the display leaves HDR mode
//      (Win+Alt+B). If it does not, the share simply goes quiet and the feature has nothing to hook.
//   2. A fresh `CreateForMonitor` on the SAME device name then succeeds, and reports the new
//      reference white (480 -> 80 here) so the tone map lands on the first frame.
//   3. Which Electron `screen` events Windows emits during the toggle. This one is a GATE on the
//      design, not a detail: main drops the whole listing on `display-metrics-changed` and drops
//      the PICK as well on `display-added`/`display-removed`. If a mode change emits add/remove,
//      `selectedSourceId` is cleared, the consent gate refuses, and no recovery is possible at all
//      without a re-pick — whatever the addon does.
//
// Every claim is reported against a WITNESS that the experiment actually happened: the display's
// own `hdr` flag. The first version of this probe polled `closed` alone and duly reported "the item
// did not close" after a run in which HDR never moved — a negative result invented out of an absent
// measurement. Hence `hdrChangedAfterMs`: no flip, no verdict.
//
// INTERACTIVE. It cannot be automated: only a human can toggle HDR, and the OS refuses to be told
// to. Win+Alt+B is the shortcut; Settings > System > Display > Use HDR is the reliable route if the
// shortcut is disabled. Run it, follow the two prompts, and paste the JSON back.
//
// Run from electron/ (ELECTRON_RUN_AS_NODE must NOT be set):
//   pnpm exec electron ../tools/hdr-toggle-recovery.cjs
const fs = require('node:fs');
const path = require('node:path');
const { app, screen } = require('electron');

const addon = require(path.join(__dirname, '..', 'electron', 'native', 'build', 'Release', 'streamshare_capture.node'));

// Written as well as printed, like every other probe here. This one is INTERACTIVE, so whoever
// pressed the keys is not necessarily whoever reads the result — a run whose output lives only in
// somebody's terminal scrollback is a measurement nobody else can use.
const OUT = path.join(__dirname, 'hdr-toggle-recovery.json');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => process.stdout.write(`${line}\n`);
const WAIT_MS = 60000;

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const out = { events: [] };
  const t0 = Date.now();
  // Recorded with timestamps, because ORDER is the question: an add/remove that lands before the
  // renderer's 100 ms `closed` poll notices anything has already cleared the pick.
  const watch = (name) => (_e, display) => out.events.push({ at: Date.now() - t0, name, id: display?.id ?? null });
  screen.on('display-added', watch('display-added'));
  screen.on('display-removed', watch('display-removed'));
  screen.on('display-metrics-changed', watch('display-metrics-changed'));

  let frames = 0;
  /** Start on `device` and let it settle. The frame counter keeps running until the next stop. */
  const runCapture = async (device, white, label) => {
    frames = 0;
    addon.startCapture(device, white, () => {
      frames++;
    });
    await settle(1200);
    const stats = addon.captureStats();
    return {
      label,
      running: stats.running,
      frames,
      size: `${stats.width}x${stats.height}`,
      startupTotalMs: stats.startupTotalMs,
      startupDeviceMs: stats.startupDeviceMs,
      displaySdrWhiteNits: stats.displaySdrWhiteNits,
      displaySdrWhiteMeasured: stats.displaySdrWhiteMeasured,
    };
  };

  /** Watch the display's `hdr` flag (the witness) and the item's `closed` flag (the measurement)
   *  independently, and count the frames that still arrive while it happens (the third answer). */
  const waitForToggle = async (device, wasHdr) => {
    const started = Date.now();
    const framesBefore = frames;
    const r = { hdrChangedAfterMs: null, sdrWhiteNitsAfter: null, closedAfterMs: null, framesDuring: 0 };
    for (;;) {
      const elapsed = Date.now() - started;
      if (elapsed > WAIT_MS) break;
      if (r.closedAfterMs === null && addon.captureStats().closed) r.closedAfterMs = elapsed;
      if (r.hdrChangedAfterMs === null) {
        const now = addon.listDisplays().find((d) => d.deviceName === device);
        if (now && now.hdr !== wasHdr) {
          r.hdrChangedAfterMs = elapsed;
          r.sdrWhiteNitsAfter = now.sdrWhiteNits;
        }
      }
      if (r.closedAfterMs !== null) break;
      // HDR moved and two seconds later nothing has closed. That IS the answer — stop waiting.
      if (r.hdrChangedAfterMs !== null && elapsed > r.hdrChangedAfterMs + 2000) break;
      await settle(100);
    }
    r.framesDuring = frames - framesBefore;
    return r;
  };

  const verdict = (r) =>
    r.hdrChangedAfterMs === null
      ? 'INCONCLUSIVE — HDR never changed state; nothing was toggled, so nothing was measured'
      : r.closedAfterMs === null
        ? `NO — HDR flipped after ${r.hdrChangedAfterMs} ms and the item did NOT close (${r.framesDuring} frames still arrived)`
        : `YES — the item closed ${r.closedAfterMs - r.hdrChangedAfterMs} ms after HDR flipped`;

  try {
    const before = addon.listDisplays();
    const target = before.find((d) => d.hdr);
    out.before = before.map((d) => ({ deviceName: d.deviceName, hdr: d.hdr, sdrWhiteNits: d.sdrWhiteNits }));
    if (!target) throw new Error('no display is in HDR mode — turn HDR on first, there is nothing to toggle off');
    const device = target.deviceName;
    out.device = device;

    out.initial = await runCapture(device, target.sdrWhiteNits, 'HDR on');
    say('');
    say(`  Capturing ${device} (HDR, ${target.sdrWhiteNits} nits). ${out.initial.frames} frames so far.`);
    say(`  >>> Switch HDR OFF now (Win+Alt+B, or Settings > Display > Use HDR). Up to ${WAIT_MS / 1000} s...`);
    say('');

    out.off = await waitForToggle(device, true);
    out.claim1 = verdict(out.off);
    out.eventsDuringOff = out.events.slice();

    // Claim 2. Stop first — the addon refuses a second session, and Stop() is also what clears
    // `closed`. Same device name: the recovery has no other handle to the display.
    addon.stopCapture();
    await settle(300);
    const now = addon.listDisplays().find((d) => d.deviceName === device);
    out.afterOff = now ? { hdr: now.hdr, sdrWhiteNits: now.sdrWhiteNits } : null;
    try {
      out.restart = await runCapture(device, now?.sdrWhiteNits ?? 80, 'after HDR off');
      out.claim2 =
        out.restart.frames > 0
          ? 'YES — a fresh CreateForMonitor works and produces frames'
          : 'NO — the restart produced no frames';
    } catch (err) {
      out.restart = { error: String(err && err.message ? err.message : err) };
      out.claim2 = 'NO — the restart threw';
    }

    // And back, because the reverse toggle decides whether the cooldown has to survive a second
    // close a few seconds after the first.
    say(`  >>> Switch HDR back ON now. Up to ${WAIT_MS / 1000} s...`);
    say('');
    const eventsBeforeOn = out.events.length;
    out.on = await waitForToggle(device, out.afterOff?.hdr ?? false);
    out.claim1Reverse = verdict(out.on);
    out.eventsDuringOn = out.events.slice(eventsBeforeOn);

    addon.stopCapture();
    await settle(300);
    const restored = addon.listDisplays().find((d) => d.deviceName === device);
    out.afterOn = restored ? { hdr: restored.hdr, sdrWhiteNits: restored.sdrWhiteNits } : null;
    try {
      out.restartHdr = await runCapture(device, restored?.sdrWhiteNits ?? 80, 'after HDR back on');
    } catch (err) {
      out.restartHdr = { error: String(err && err.message ? err.message : err) };
    }
    addon.stopCapture();

    // Claim 3 — the design gate. add/remove clears the PICK in main (forgetPick); a bare
    // metrics-changed only clears the listing, which the plan proposes to stop doing.
    const kinds = new Set(out.events.map((e) => e.name));
    // EITHER phase, not just the first. The operator can miss the first prompt and flip during the
    // second — which is exactly what happened on the run that settled this, and the verdict then
    // said INCONCLUSIVE while `events` held the answer. A guard that ignores half the experiment is
    // how a measurement gets buried under "not measured".
    const flipped = out.off.hdrChangedAfterMs !== null || out.on?.hdrChangedAfterMs != null;
    out.claim3 = !flipped
      ? 'INCONCLUSIVE — nothing was toggled'
      : kinds.has('display-added') || kinds.has('display-removed')
        ? 'BLOCKED — the toggle emits add/remove, so main clears selectedSourceId and nothing can be approved without a re-pick'
        : kinds.has('display-metrics-changed')
          ? 'OK — only display-metrics-changed, so the pick survives; dropping the LISTING there was what stood in the way'
          : 'OK — the toggle emits no screen event at all; neither the pick nor the listing is touched';
  } catch (err) {
    out.error = String(err && err.stack ? err.stack : err);
    try {
      addon.stopCapture();
    } catch {
      /* nothing was running */
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  say(JSON.stringify(out, null, 2));
  // The three claims, so a glance at the tail says whether the run is usable.
  for (const k of ['claim1', 'claim1Reverse', 'claim2', 'claim3']) if (out[k]) say(`${k}: ${out[k]}`);
  app.exit(out.error ? 1 : 0);
});
