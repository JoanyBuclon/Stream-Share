// Does native capture actually become a track a viewer could receive?
//
// This is the acceptance for "addon in the preload" + "frames pushed as a MediaStreamTrack". It
// runs the REAL preload (electron/out/preload.cjs) and imports the REAL src/lib/native-video.ts
// through the dev server, so nothing here is a reimplementation of the code under test.
//
// Two things get asserted that no unit test can:
//  - frames flow end to end (addon → preload → transfer → generator → track), at a real cadence;
//  - the track survives a loopback RTCPeerConnection and reaches the HARDWARE encoder. That last
//    one matters more than it looks: we prefer H.265, which has NO software fallback in Chromium,
//    so a track the encoder cannot take does not degrade — it can go black.
//
// Needs: `pnpm build` in electron/, `pnpm build:native`, and the dev server on :4321.
// Run from electron/ (ELECTRON_RUN_AS_NODE must NOT be set):
//   pnpm exec electron ../tools/native-track.cjs
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, screen, ipcMain, session, desktopCapturer } = require('electron');

// The real preload asks main for this synchronously, before anything else. With no handler it gets
// undefined, throws, and Electron fails the whole page load with a bare ERR_FAILED — which reads
// like a dev-server problem and is not one.
// The native path now checks the picked display with main before capturing. The harness bypasses
// ss:select-source (that needs the whole main process), so it approves its own target here — and
// that is a real gap: the gate itself is only exercised in production.
let approved = '';
ipcMain.on('ss:approved-device', (event) => { event.returnValue = approved; });
ipcMain.on('ss:config', (event) => {
  event.returnValue = { appOrigin: process.env.SS_APP_ORIGIN || 'http://localhost:4321', packaged: false };
});

// Enough of main's consent gate to answer one question the routing work depends on: the native path
// hands back video ONLY, so where does system audio come from? getDisplayMedia bundles a 'loopback'
// track today, and this checks whether that audio survives stopping its video sibling.
let audioProbeSource = null;
app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!audioProbeSource) return callback({});
    callback({ video: audioProbeSource, audio: request.audioRequested ? 'loopback' : undefined });
  });
});

const OUT = path.join(__dirname, 'native-track.json');
const PAGE = process.env.SS_BENCH_URL || 'http://localhost:4321/';
const SECONDS = Number(process.env.SS_PROBE_SECONDS) > 0 ? Number(process.env.SS_PROBE_SECONDS) : 6;

/** Same mover as tools/wgc-latency.cjs: WGC is change-driven, so an idle desktop measures nothing. */
function moverHtml() {
  return (
    'data:text/html,' +
    encodeURIComponent(`<body style="margin:0;background:#101014;overflow:hidden">
<canvas id="c" width="480" height="270"></canvas><script>
const x=document.getElementById('c').getContext('2d');let t=0;
(function f(){t+=4;x.fillStyle='#101014';x.fillRect(0,0,480,270);
x.fillStyle='#3a3a44';x.fillRect((t%520)-40,0,40,270);requestAnimationFrame(f)})();
</script></body>`)
  );
}

const SCRIPT = (deviceName, sdrWhiteNits, seconds) => `(async () => {
  const rtpIdOf = (stats) => { let id = null; stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') id = s.id; }); return id; };
  const DEVICE = ${JSON.stringify(deviceName)}, SDR_WHITE = ${sdrWhiteNits};
  const out = { deviceName: DEVICE, sdrWhiteNits: SDR_WHITE };
  try {
    // The real module, served by Vite in dev — not a copy of its logic.
    const { captureNative, canCaptureNative } = await import('/src/lib/native-video.ts');
    out.canCaptureNative = canCaptureNative();
    if (!out.canCaptureNative) return JSON.stringify(out);
    out.h265Available = (RTCRtpSender.getCapabilities('video')?.codecs ?? []).some((c) => c.mimeType === 'video/H265');

    const capture = await captureNative(DEVICE, SDR_WHITE);
    out.trackReadyState = capture.track.readyState;

    // What the generated track tells the rest of the app about itself. This decides where the
    // quality settings have to be applied: host.ts caps resolution with scaleResolutionDownBy
    // computed from getSettings().height, and caps fps with applyConstraints — neither of which a
    // MediaStreamTrackGenerator is obliged to support. Reported, not gated: these are facts about
    // the platform that the routing work needs, not pass/fail criteria.
    out.trackFacts = { settings: capture.track.getSettings(), constraintsError: null, afterConstraints: null };
    try {
      await capture.track.applyConstraints({ frameRate: { max: 10 } });
      out.trackFacts.afterConstraints = capture.track.getSettings();
    } catch (err) {
      out.trackFacts.constraintsError = String(err);
    }

    // A loopback peer connection, the same shape host.ts builds per viewer. Without this the track
    // is never encoded and "it works" would mean "an object exists".
    const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
    const received = new Promise((r) => { pc2.ontrack = (e) => r(e.track); });
    const sender = pc1.addTrack(capture.track, new MediaStream([capture.track]));
    // Same preference order production uses, so the encoder we measure is the one that ships.
    const tx = pc1.getTransceivers()[0];
    const order = ['video/H265', 'video/VP9', 'video/AV1', 'video/H264', 'video/VP8'];
    const caps = RTCRtpSender.getCapabilities('video');
    if (caps && tx.setCodecPreferences) {
      tx.setCodecPreferences([...caps.codecs].sort((a, b) => {
        const r = (m) => { const i = order.indexOf(m); return i === -1 ? order.length : i; };
        return r(a.mimeType) - r(b.mimeType);
      }));
    }
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);
    out.remoteTrack = (await received).kind;

    // Two samples, because a total says nothing about WHEN. Setting up the peer connection blocks
    // the JS thread for a while, and frames dropped during that burst are not the same finding as
    // frames dropped once the stream is running.
    await new Promise((r) => setTimeout(r, 1000));
    const afterSetup = window.native.nativeCaptureStats();
    await new Promise((r) => setTimeout(r, ${seconds} * 1000));

    // The gate that was missing, and the one that matters most here: every other check is satisfied
    // by a stream of black or of one frozen image. The reused ArrayBuffer in the addon fails
    // exactly that way — right cadence, right resolution, encoded, identical. So: pull two frames
    // off the RECEIVED track, seconds apart, and prove the pixels move and are not all zero.
    try {
      const proc = new MediaStreamTrackProcessor({ track: await received });
      const reader = proc.readable.getReader();
      const grab = async () => {
        const { value } = await reader.read();
        const buf = new Uint8Array(value.allocationSize({ rect: { x: 0, y: 0, width: value.codedWidth, height: 64 } }));
        await value.copyTo(buf, { rect: { x: 0, y: 0, width: value.codedWidth, height: 64 } });
        value.close();
        let sum = 0;
        for (let i = 0; i < buf.length; i += 97) sum += buf[i];
        return { sum, bytes: buf.length, sample: Array.from(buf.slice(0, 32)) };
      };
      const a = await grab();
      await new Promise((r) => setTimeout(r, 900));
      const b = await grab();
      reader.cancel();
      out.picture = {
        nonZero: a.sum > 0 || b.sum > 0,
        changed: a.sample.some((v, i) => v !== b.sample[i]) || a.sum !== b.sum,
        sums: [a.sum, b.sum],
      };
    } catch (err) {
      out.picture = { error: String(err) };
    }

    const stats = await pc1.getStats();
    let rtp = null, codec = null;
    stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') rtp = s; });
    stats.forEach((s) => { if (s.type === 'codec' && rtp && s.id === rtp.codecId) codec = s; });
    // encoderImplementation came back empty once; dumped so a missing FIELD can be told from a
    // missing hardware encoder. (Chromium has no software HEVC encoder at all, so H.265 at this
    // resolution and rate is hardware whatever the field says.)
    out.rtpKeys = rtp ? Object.keys(rtp) : [];
    out.encoded = {
      framesSent: rtp?.framesSent ?? 0,
      framesEncoded: rtp?.framesEncoded ?? 0,
      frameWidth: rtp?.frameWidth ?? 0,
      frameHeight: rtp?.frameHeight ?? 0,
      encoder: rtp?.encoderImplementation ?? '',
      powerEfficient: rtp?.powerEfficientEncoder ?? null,
      codec: (codec?.mimeType ?? '').replace(/^video\\//, ''),
    };
    // Does loopback audio survive on its own? The native path produces no audio track, and turning
    // HDR on must not silently kill the sound the getDisplayMedia path bundles for free.
    try {
      const withAudio = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
      });
      const a = withAudio.getAudioTracks()[0];
      withAudio.getVideoTracks().forEach((t) => t.stop());
      await new Promise((r) => setTimeout(r, 1200));
      out.audioAlone = a
        ? { readyState: a.readyState, muted: a.muted, enabled: a.enabled, label: a.label, settings: a.getSettings() }
        : { none: true };
      a?.stop();
    } catch (err) {
      out.audioAlone = { error: String(err) };
    }

    // The fps cap. It cannot go through applyConstraints (measured above), so it is enforced in
    // the addon before any GPU work — which means the proof has to be that the DELIVERED rate
    // actually falls and "skipped" climbs, not merely that a setter was called without throwing.
    try {
      const t0 = window.native.nativeCaptureStats();
      capture.setFps(10);
      await new Promise((r) => setTimeout(r, 2000));
      const t1 = window.native.nativeCaptureStats();
      out.fpsCap = {
        deliveredPerSec: +(((t1.frames - t1.skipped) - (t0.frames - t0.skipped)) / 2).toFixed(1),
        skippedDelta: t1.skipped - t0.skipped,
      };
      capture.setFps(0);
    } catch (err) {
      out.fpsCap = { error: String(err) };
    }

    // The still-screen repeater. The harness main process hides the mover for this window, so WGC
    // stops producing (0.2 fps on an idle desktop, measured). Without the repeater the encoder gets
    // nothing, cannot answer a keyframe request, and a viewer joining now would sit on black until
    // the host moved something. What is asserted is that frames keep being ENCODED with no source
    // activity — the addon's own counter deliberately does not move here.
    // Stashed so the second script can pick the session up: only main can hide the mover, and the
    // still-screen case has to be produced between two measurements. Hence two phases.
    window.__ss = { capture, pc1, pc2, received: await received };

    out.droppedInPage = capture.droppedInPage();
    out.native = window.native.nativeCaptureStats();
    out.steady = { frames: out.native.frames - afterSetup.frames, dropped: out.native.dropped - afterSetup.dropped };
    out.duringSetup = { frames: afterSetup.frames, dropped: afterSetup.dropped };
  } catch (err) {
    out.error = String(err && err.stack ? err.stack : err);
  }
  return JSON.stringify(out);
})()`;

/**
 * Phase two, run while main is hiding the mover: does anything still reach the encoder?
 *
 * WGC produces nothing on a still screen, so without the repeater in native-video.ts the encoder
 * has no input, cannot answer a keyframe request, and a viewer joining right now would sit on black
 * until the host moved something. `getDisplayMedia` does not behave that way, so the native path
 * must not either. The native frame counter deliberately should NOT move here — that is the point.
 */
const IDLE = `(async () => {
  const out = {};
  try {
    const rtpIdOf = (stats) => { let id = null; stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') id = s.id; }); return id; };
    const encoded = async () => { const s = await window.__ss.pc1.getStats(); return s.get(rtpIdOf(s))?.framesEncoded ?? 0; };
    await new Promise((r) => setTimeout(r, 800)); // let the last real frames drain
    const before = await encoded();
    const nativeBefore = window.native.nativeCaptureStats().frames;
    await new Promise((r) => setTimeout(r, 2500));
    out.encodedWhileStill = (await encoded()) - before;
    // Repeated frames must carry INCREASING timestamps: rebasing them on the (unchanging) source
    // frame produced identical ones, which an encoder is entitled to discard.
    try {
      const proc = new MediaStreamTrackProcessor({ track: window.__ss.received });
      const reader = proc.readable.getReader();
      const stamps = [];
      for (let i = 0; i < 3; i++) { const { value } = await reader.read(); stamps.push(value.timestamp); value.close(); }
      reader.cancel();
      out.stamps = stamps;
      out.stampsIncrease = stamps.every((v, i) => i === 0 || v > stamps[i - 1]);
    } catch (err) { out.stampsError = String(err); }
    out.nativeFramesWhileStill = window.native.nativeCaptureStats().frames - nativeBefore;
  } catch (err) {
    out.error = String(err);
  }
  return JSON.stringify(out);
})()`;

/** Phase three: shut down, then start again — "switch source", the flow real users hit. */
const FINISH = (deviceName, sdrWhiteNits) => `(async () => {
  const out = {};
  try {
    const { captureNative } = await import('/src/lib/native-video.ts');
    const { capture, pc1, pc2 } = window.__ss;
    capture.stop();
    out.afterStop = { readyState: capture.track.readyState, running: window.native.nativeCaptureStats()?.running };
    pc1.close(); pc2.close();
    // The old two-call handshake closed the live frame port BEFORE the call that could fail, so a
    // second capture threw "already running" and left the first live and frozen. Happy paths never
    // saw it.
    const again = await captureNative(${JSON.stringify(deviceName)}, ${sdrWhiteNits});
    await new Promise((r) => setTimeout(r, 800));
    const s2 = window.native.nativeCaptureStats();
    out.restart = { readyState: again.track.readyState, frames: s2.frames, running: s2.running };
    again.stop();
  } catch (err) {
    out.restart = { error: String(err) };
  }
  return JSON.stringify(out);
})()`;

app.whenReady().then(async () => {
  const result = {};
  let win = null;
  let mover = null;
  try {
    const addon = require(path.join(__dirname, '..', 'electron', 'native', 'build', 'Release', 'streamshare_capture.node'));
    const all = addon.listDisplays();
    // SS_DISPLAY forces a specific output — used to separate "the pipeline is too slow" from "this
    // resolution is too big", which the same drop rate cannot tell apart on one screen.
    const target = process.env.SS_DISPLAY ? all.find((d) => d.deviceName.endsWith(process.env.SS_DISPLAY)) : (all.find((d) => d.hdr) ?? all[0]);
    if (!target) throw new Error('no display reported');
    result.target = target;
    approved = target.deviceName;

    // Both windows are placed relative to the CAPTURED display, not the primary one. Getting this
    // wrong is silent and total: the mover animates somewhere the capture cannot see, WGC is
    // change-driven, and the whole run then measures an idle desktop while looking healthy.
    const displays = screen.getAllDisplays();
    const captured =
      displays.find((d) => {
        const scale = d.scaleFactor || 1;
        return Math.abs(Math.round(d.bounds.x * scale) - target.left) <= 1 && Math.abs(Math.round(d.bounds.y * scale) - target.top) <= 1;
      }) ?? screen.getPrimaryDisplay();
    // …and the harness window must NOT sit on it: its own UI would be in every frame.
    const elsewhere = displays.find((d) => d.id !== captured.id) ?? captured;

    win = new BrowserWindow({
      x: elsewhere.bounds.x + 20,
      y: elsewhere.bounds.y + 20,
      width: 900,
      height: 500,
      show: true,
      webPreferences: {
        // The REAL preload. If the addon fails to load inside it, this is where it shows.
        preload: path.join(__dirname, '..', 'electron', 'out', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    await win.loadURL(PAGE);

    mover = new BrowserWindow({
      x: captured.bounds.x + 60,
      y: captured.bounds.y + 60,
      width: 480,
      height: 270,
      frame: false,
      skipTaskbar: true,
      webPreferences: { backgroundThrottling: false },
    });
    await mover.loadURL(moverHtml());
    await new Promise((r) => setTimeout(r, 700));

    // A real DesktopCapturerSource for the audio probe above.
    const caps = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    audioProbeSource = caps[0] ?? null;

    const run = async (script, ms) =>
      JSON.parse(
        await Promise.race([
          win.webContents.executeJavaScript(script),
          new Promise((_, reject) => setTimeout(() => reject(new Error('page timed out')), ms)),
        ]),
      );

    Object.assign(result, await run(SCRIPT(target.deviceName, target.sdrWhiteNits, SECONDS), (SECONDS + 30) * 1000));
    // Freeze the screen for the repeater test — only main can do this, which is why the page script
    // is split in three rather than driving it itself.
    //
    // Hiding the mover is all this can do, and it is NOT enough to make the display still — see
    // the gate, which now says so instead of failing. Covering the whole captured display with an
    // opaque always-on-top window was tried and changed nothing (38→39, 45→48 frames over the same
    // 2.5 s), so the frames are not coming from anything a window can hide.
    mover.hide();
    result.idle = await run(IDLE, 20_000);
    mover.show();
    Object.assign(result, await run(FINISH(target.deviceName, target.sdrWhiteNits), 20_000));
    result.verdict = verdict(result, SECONDS);
  } catch (err) {
    result.error = String(err && err.stack ? err.stack : err);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  mover?.destroy();
  win?.destroy();
  app.exit(result.error || result.verdict?.some((v) => !v.pass) ? 1 : 0);
});

/** Written so that absence of data fails — the same mistake was made once already in
 *  tools/wgc-latency.cjs, where three gates went green on a capture that produced nothing. */
function verdict(r, seconds) {
  const e = r.encoded ?? {};
  const n = r.native ?? {};
  return [
    { gate: 'addon loaded in the preload', pass: r.canCaptureNative === true, value: String(r.canCaptureNative) },
    { gate: 'track is live', pass: r.trackReadyState === 'live', value: String(r.trackReadyState) },
    { gate: 'a track reached the peer', pass: r.remoteTrack === 'video', value: String(r.remoteTrack) },
    {
      gate: 'frames encoded at cadence',
      pass: e.framesEncoded >= seconds * 20,
      value: `${e.framesEncoded} in ${seconds}s (need ${seconds * 20})`,
    },
    { gate: 'full resolution', pass: e.frameWidth === n.width && e.frameWidth > 0, value: `${e.frameWidth}x${e.frameHeight} of ${n.width}x${n.height}` },
    // The one gate the others cannot stand in for: everything above is satisfied by a stream of
    // black, or of one frozen image. The reused ArrayBuffer fails in exactly that shape.
    {
      gate: 'the picture is real and moving',
      pass: r.picture?.nonZero === true && r.picture?.changed === true,
      value: r.picture?.error ?? `nonZero=${r.picture?.nonZero} changed=${r.picture?.changed}`,
    },
    // Nothing may fail quietly upstream of the encoder either.
    {
      gate: 'no silent losses',
      pass: (n.failed ?? -1) === 0 && (n.undelivered ?? -1) === 0 && (n.orphanedFrames ?? -1) === 0 && n.closed === false,
      value: `failed=${n.failed} undelivered=${n.undelivered} orphaned=${n.orphanedFrames} closed=${n.closed}`,
    },
    {
      gate: 'stop then start again',
      pass: r.restart?.readyState === 'live' && r.restart?.running === true,
      value: r.restart?.error ?? `readyState=${r.restart?.readyState} running=${r.restart?.running}`,
    },
    // WGC produces nothing on a still screen. Without the repeater the encoder gets nothing either,
    // and a viewer joining then waits for the host to move something before seeing anything.
    //
    // This gate can only speak when the display actually goes quiet, and on a machine somebody is
    // using it often does not: runs on this box alternate between 3 and 48 frames over the same
    // 2.5 s window, with the mover hidden either way, and covering the whole display with an opaque
    // window changed nothing — so it is not the desktop content. Cause not identified.
    //
    // So: skipped rather than failed when frames kept pouring in, on the same principle as the
    // H.265 gate below — it would be asserting a property of the ROOM. The repeater logic itself is
    // covered deterministically in e2e/desktop-hdr.spec.ts ("a still screen keeps feeding the
    // encoder", frames counted off the track); what only this gate can add is the same thing
    // against real WGC, on the runs where the screen cooperates.
    (() => {
      const captured = r.idle?.nativeFramesWhileStill ?? 0;
      const encoded = r.idle?.encodedWhileStill ?? 0;
      const still = captured <= 5; // 2 fps over 2.5 s — anything above and there was nothing to repeat
      return {
        gate: 'a still screen still feeds the encoder',
        // STRICTLY more encoded than captured: the surplus can only be repeats. An absolute
        // threshold was the wrong test — a real desktop is never perfectly still (a clock digit is
        // enough), so the first version of this gate went green while the repeater did nothing.
        pass: r.idle?.error ? false : !still || encoded > captured,
        value:
          r.idle?.error ??
          (still
            ? `${encoded} encoded from ${captured} captured over 2.5s (surplus = repeats)`
            : `skipped — the display never went still (${captured} real frames in 2.5s)`),
      };
    })(),
    // Enforced in the addon, so the proof must be a real drop in the delivered rate.
    {
      gate: 'the fps cap actually caps',
      pass: (r.fpsCap?.deliveredPerSec ?? 99) <= 11 && (r.fpsCap?.skippedDelta ?? 0) > 0,
      value: r.fpsCap?.error ?? `${r.fpsCap?.deliveredPerSec}/s delivered at a cap of 10, ${r.fpsCap?.skippedDelta} skipped`,
    },
    // Video-only capture must not cost the share its sound.
    {
      gate: 'system audio survives the native path',
      pass: r.audioAlone?.readyState === 'live' && r.audioAlone?.muted === false,
      value: r.audioAlone?.error ?? `${r.audioAlone?.label} readyState=${r.audioAlone?.readyState} muted=${r.audioAlone?.muted}`,
    },
    // Hardware encoding, established by elimination rather than by the field that should say so:
    // `encoderImplementation` and `powerEfficientEncoder` are NOT exposed by Electron 43's stats
    // (verified against Object.keys — absent, not empty), so there is nothing to read. But Chromium
    // ships no software HEVC encoder at all, so H.265 at this resolution and rate cannot be
    // anything but hardware. If the negotiated codec ever stops being H.265 this stops proving it.
    //
    // Skipped rather than failed when the machine offers no H.265: Chromium then negotiates VP9,
    // production is perfectly fine, and a red gate would only mean "this harness was run somewhere
    // other than the dev box". It asserts a property of the MACHINE, not of the code.
    {
      gate: 'hardware encoder (H.265 has no software path)',
      pass: r.h265Available === false || e.codec === 'H265',
      value: r.h265Available === false ? 'skipped — no H.265 on this machine' : `${e.codec} (encoderImplementation not exposed by Electron 43)`,
    },
    // Steady state only. Frames dropped while the page builds its peer connection are the design
    // working: refusing to queue recovers instantly, where a queue would have turned that burst
    // into permanent latency. Measured: 37 dropped in the first second, 0 over the next six.
    {
      gate: 'no backpressure once running',
      pass: (r.steady?.dropped ?? -1) === 0 && (r.droppedInPage ?? -1) === 0,
      value: `${r.steady?.dropped} steady (${r.duringSetup?.dropped} during setup), ${r.droppedInPage} in the page`,
    },
    { gate: 'stop() actually stops', pass: r.afterStop?.running === false, value: `running=${r.afterStop?.running}` },
    {
      gate: 'repeated frames advance in time',
      pass: r.idle?.stampsIncrease === true,
      value: r.idle?.stampsError ?? JSON.stringify(r.idle?.stamps ?? []),
    },
  ];
}
