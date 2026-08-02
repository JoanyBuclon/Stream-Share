// Host controller: capture a source, open one Peer per viewer (mesh), manage the viewer
// sidebar (per-viewer quality, kick/ban, stats), drive the settings modal (source / quality /
// audio), pause/resume the stream, and reclaim the room after a signaling blip.
// See docs/frontend.md.

import { Signaling, type ServerMessage, type ConnectionStatus, type RoomViewer } from './signaling.ts';
import { Peer, type PeerSignal } from './peer.ts';
import { AudioMixer } from './audio.ts';
import { serial } from './serial.ts';
import { createWakeLock } from './wakelock.ts';
import { reconcileRoster } from './roster.ts';
import { el, hook, show, hide, setText, initials } from './dom.ts';
import { pickSource } from './source-picker.ts';
import { NativeAudio } from './native-audio.ts';
import {
  applyPreset,
  parseQuality,
  serializeQuality,
  QUALITY_KEY,
  effectiveScale,
  maxBitrateBps,
  estimatedUpload,
  contentHintFor,
  degradationFor,
  resLabel,
  sourceTier,
  DEFAULT_QUALITY,
  type Quality,
  type PresetName,
  type ResolutionTarget,
  type ViewerTier,
} from './settings.ts';

/** Screen capture only exists on desktop browsers — mobile has no getDisplayMedia at all. */
export const supportsDisplayMedia = (): boolean => typeof navigator.mediaDevices?.getDisplayMedia === 'function';

export interface HostInit {
  code: string;
  display: string;
  hostToken: string;
  iceServers: RTCIceServer[];
}

interface ViewerEntry {
  pseudo: string;
  row: HTMLElement;
  peer: Peer | null;
  tier: ViewerTier; // per-viewer quality request (default 'auto'); never above the host cap
}

export class HostController {
  private readonly sig: Signaling;
  private readonly code: string;
  private readonly hostToken: string;
  private config: RTCConfiguration;
  private readonly onEnd: () => void;
  private stream: MediaStream | null = null; // raw capture (video + system audio), used for the preview
  private outgoing: MediaStream | null = null; // what peers receive (video + processed audio)
  private paused = false; // when true, buildOutgoing drops the video track
  private sourceId: string | null = null; // desktop only: last pick, preselected in the picker
  // Desktop only, session state — deliberately NOT in `Quality`: that is pure quality math the
  // presets spread over, and an app name has no business being persisted with a bitrate.
  /** Names from the last listing. */
  private audioApps: string[] = [];
  /** What the shell CONFIRMED is running, and nothing else — there is deliberately no second
   *  field holding what the host *meant*. Every checkbox renders from `spec` (see isAudible), so
   *  the panel cannot claim a mute the shell refused, dropped or never armed: the whole class of
   *  bugs here is inaudible to the host, and the only defence is having one truth to read.
   *  `null` = no native capture, viewers get the loopback track. `{ include: [] }` = a live
   *  capture holding nothing, i.e. silence. `sessions` carries the pids, for restart detection. */
  private live: { spec: LiveSpec; sessions: NativeCapturedApp[] } | null = null;
  private audioSeq = 0; // guards the round trip against a faster second click
  /** The last change the shell turned down. The previous capture is still running (main resolves
   *  before it stops anything), so the boxes stay honest — but a click that does nothing needs to
   *  say so, or it reads as a broken button. */
  private audioFailed = false;
  // Sticky: the shared window has no owning process, so app-only sound is impossible for it. Kept
  // as state, not just as text — the pick happens before the panel opens, and opening it resets
  // the hint line.
  private audioNoOwner = false;
  private readonly nativeAudio = new NativeAudio();
  private offAudioChunk: (() => void) | null = null;
  private quality: Quality = loadQuality();
  /** The resolution the HOST picked, before clampResolution lowers it to fit the source. Only this
   *  is ever persisted: the clamp is a property of the current source, and a desktop host mostly
   *  shares *windows*, which are almost never 2160 tall. Saving the clamped value would quietly
   *  pin the cap at 720p for every later session — including on a 4K screen, with nothing on
   *  screen to explain it. */
  private pickedResolution: ResolutionTarget = this.quality.resolution;
  private readonly mixer = new AudioMixer();
  private readonly audioQueue = serial(); // serializes outgoing rebuilds — no interleaving
  private readonly wakeLock = createWakeLock(); // keep the screen awake while hosting
  private readonly viewers = new Map<string, ViewerEntry>();
  private readonly offMessage: () => void;
  private readonly offStatus: () => void;
  private wasReconnecting = false;
  private copyTimer: ReturnType<typeof setTimeout> | null = null; // reverts the "copied ✓" flash
  // Removes every DOM listener at once on destroy() — the host screen is shared across
  // sessions, so listeners would otherwise pile up (one getDisplayMedia prompt per stale session).
  private readonly ac = new AbortController();

  constructor(sig: Signaling, init: HostInit, opts: { onEnd: () => void }) {
    this.sig = sig;
    this.code = init.code;
    this.hostToken = init.hostToken;
    this.config = { iceServers: init.iceServers };
    this.onEnd = opts.onEnd;

    setText('host-code', init.display);
    setText('host-waiting-code', init.display);

    // The host screen DOM is shared and reused across sessions — reset it to the initial
    // "no source" state so a previous share's preview/badges don't linger.
    this.resetStage();
    // A <dialog> hides itself when closed (UA display:none). Never set `hidden` on it: Tailwind's
    // Preflight `[hidden]{display:none!important}` would then survive showModal() and the modal
    // could never appear. Just make sure it's closed on a reused screen.
    const modal = el<HTMLDialogElement>('settings-modal');
    if (modal.open) modal.close();
    setText('copy-label', 'copy link');
    const waitingCopy = el('btn-copy-link-waiting'); // clear a stale "copied ✓" flash from a prior session
    waitingCopy.textContent = 'Copy room link';
    waitingCopy.dataset.copied = 'false';
    el('viewers-list').replaceChildren();
    this.refreshSidebar(); // 0 viewers → shows "waiting for friends"

    const signal = this.ac.signal;
    // Empty-state "Choose source" opens the settings modal, which is where the source button
    // lives (`btn-modal-source`) alongside quality and audio. Before a first source there is no
    // other way in: the control bar's Settings button is inside the hidden `host-quality-bar`.
    el('btn-choose-source').addEventListener('click', this.openSettings, { signal });
    el('btn-pause').addEventListener('click', () => void this.togglePause(), { signal });
    el('btn-resume').addEventListener('click', () => void this.togglePause(), { signal });
    // Once the preview knows its real dimensions: clamp the cap, re-apply, announce to viewers.
    el('host-video').addEventListener('loadedmetadata', this.onSourceReady, { signal });
    el('btn-stop').addEventListener('click', this.stopSource, { signal });
    el('btn-copy-link').addEventListener('click', this.copyLink, { signal });
    el('btn-copy-link-waiting').addEventListener('click', this.copyLink, { signal });
    this.wireSettings();
    this.renderSettings();

    this.offMessage = sig.onMessage(this.onMessage);
    this.offStatus = sig.onStatus(this.onStatus);
    void this.wakeLock.request();
  }

  // --- source capture ---

  // Desktop shell: our own grid of screens and windows (see source-picker.ts). Browser: the
  // native getDisplayMedia prompt, which is the only picker the web platform offers.
  private chooseSource = async (): Promise<void> => {
    const native = window.native;
    if (native) {
      this.closeSettings(); // the picker replaces the panel it was opened from
      let picked: string | null = null;
      try {
        picked = await pickSource(native, {
          signal: this.ac.signal,
          currentId: this.sourceId,
          share: () => this.capture(), // the picker already told the shell which source this is
        });
      } catch (e) {
        // pickSource throws only on a wiring bug (a missing id or data-hook). This method is a
        // click listener, so without this it would be an invisible unhandled rejection.
        console.error('stream-share: the source picker failed to open', e);
        setText('settings-source-hint', 'capture failed — try another source');
      }
      if (picked) {
        this.sourceId = picked; // dismissed → keep the previous pick preselected
        // The audio follows the source. Done HERE and not in setStream: `this.sourceId` is only
        // committed once pickSource resolves, so anything under setStream still sees the previous
        // window and would capture the wrong app's sound on every change after the first.
        // A window shares that app alone; a screen drops back to the system mix.
        void this.sendAudio(picked.startsWith('window:') ? { sourceId: picked } : null);
      }
      // Cancelled: put back the panel the picker replaced, or the user lands on a bare stage with
      // no way back to the quality settings. Not after teardown — that resolves null too, and a
      // dialog opened then would sit over the next screen (see destroy()).
      else if (!this.ac.signal.aborted) this.openSettings();
      return;
    }
    try {
      await this.capture();
    } catch (e) {
      // NotAllowedError = the user dismissed the prompt or a policy blocked it: intended, stay
      // silent. The bare catch used to swallow everything, so NotReadableError (source locked by
      // another app), OverconstrainedError, etc. looked identical to a cancel — a genuine failure
      // with no feedback reads as a broken button. Surface those in the existing source hint.
      if (!(e instanceof DOMException) || e.name !== 'NotAllowedError') {
        setText('settings-source-hint', 'capture failed — try another source');
      }
    }
  };

  /** Capture whatever the platform resolves the request to, and install it. Throws on failure:
   *  each caller surfaces the error where the user is actually looking. */
  private async capture(): Promise<void> {
    const constraints: DisplayMediaStreamOptions = {
      video: { frameRate: { ideal: this.quality.fps } },
      // Left to its defaults, the browser runs its voice-tuned processing (AGC / noise suppression /
      // echo cancellation) on tab & screen audio: it downmixes to mono and mangles music and games.
      // Off + explicit stereo 48 kHz = the raw capture. The mic keeps its processing (cf. AudioMixer).
      audio: this.quality.systemAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 }
        : false,
    };
    const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
    // The prompt can resolve after the controller was destroyed (Stop/leave while it was open):
    // don't run setStream on a torn-down controller — it would repaint the DOM and recreate peers.
    if (this.ac.signal.aborted) return void stream.getTracks().forEach((t) => t.stop());
    await this.setStream(stream);
  }

  private setStream = async (capture: MediaStream): Promise<void> => {
    const previous = this.stream;
    this.stream = capture;
    const video = capture.getVideoTracks()[0];
    if (video) {
      video.contentHint = contentHintFor(this.quality);
      // `once`: a new track per source change would otherwise stack a `stop` listener each time.
      video.addEventListener('ended', this.stopSource, { once: true, signal: this.ac.signal }); // "Stop sharing" from the browser chrome, or the shared window closing
    }
    this.applyFps();
    const preview = el<HTMLVideoElement>('host-video');
    preview.srcObject = capture;
    show(preview);
    hide(el('host-empty'));
    show(el('host-stage-meta'));
    show(el('host-live-badge'));
    show(el('btn-stop'));
    show(el('btn-pause'));
    show(el('host-quality-bar'));
    setText('host-source-name', video?.label || 'screen');

    try {
      await this.pushOutgoing(); // build outgoing + hot-swap existing viewers (serialized)
      // A source arriving after stopSource / a no-source join: wake every viewer held on the paused
      // screen. Emitted after pushOutgoing so the video track is swapped in before they flip to live.
      if (!this.paused) for (const peerId of this.viewers.keys()) this.sig.signal(peerId, { control: 'resume' });
      for (const [peerId, entry] of this.viewers) if (!entry.peer) this.offerTo(peerId, entry);
      this.applyVideoQualityAll(); // existing viewers: re-apply with the new source's height
    } finally {
      previous?.getTracks().forEach((t) => t.stop()); // stop the old source even if the rebuild failed
      this.renderSettings();
      this.renderPause(); // a source change during a pause must keep the paused stage/badges
    }
  };

  // Build the stream peers receive: capture video + processed audio (system / mic / mixed / none).
  private async buildOutgoing(): Promise<MediaStream> {
    const out = new MediaStream();
    if (!this.stream) {
      // No source → empty stream; viewers are held on the paused screen. Release the mic capture and
      // disconnect the graph (the system track it fed is now stopped) so no "mic on" light lingers on
      // the choose-source screen. The mic *preference* persists — re-acquired on the next source.
      await this.mixer.build(null, false);
      this.outgoing = out;
      return out;
    }
    const video = this.paused ? null : this.stream.getVideoTracks()[0];
    if (video) out.addTrack(video);
    // Muting an app swaps the source of "system audio": the shell's WASAPI sessions instead of the
    // loopback track getDisplayMedia handed us. The loopback track stays alive and simply isn't
    // used — exactly what turning systemAudio off already does — so ticking a box never re-runs
    // capture() and never disturbs viewers. `[]` is a live capture with nothing in it: still the
    // native track, and it is silent, which is the point.
    const systemTrack = !this.quality.systemAudio
      ? null
      : this.live
        ? this.nativeAudio.track()
        : (this.stream.getAudioTracks()[0] ?? null);
    let mixed: MediaStreamTrack | null;
    try {
      mixed = await this.mixer.build(systemTrack, this.quality.mic);
    } catch {
      this.quality = { ...this.quality, mic: false }; // mic permission denied → drop it, keep video/system
      mixed = await this.mixer.build(systemTrack, false);
    }
    if (mixed) {
      // Tells the stack what the track carries, so it stops optimising for intelligibility over
      // fidelity (same lever as the video contentHint above). System audio present — alone or mixed
      // with the mic — means music/games: keep the dynamics and the stereo image. Mic alone is voice.
      mixed.contentHint = systemTrack ? 'music' : 'speech';
      out.addTrack(mixed);
    }
    this.outgoing = out;
    return out;
  }

  // Serialized: rebuild the outgoing stream, then hot-swap it onto every connected viewer.
  // Contains any build failure (e.g. AudioContext refused) so the task never rejects — callers
  // (setStream, toggles) keep going and viewers keep at least the last good stream.
  private pushOutgoing(): Promise<void> {
    return this.audioQueue(async () => {
      let out: MediaStream | null;
      try {
        out = await this.buildOutgoing();
      } catch {
        out = this.outgoing;
      }
      if (out) for (const entry of this.viewers.values()) if (entry.peer) void entry.peer.replaceTracks(out);
    });
  }

  private offerTo(peerId: string, entry: ViewerEntry): void {
    const out = this.outgoing ?? new MediaStream(); // no source yet → offer an empty (paused) stream
    const peer = new Peer(this.config, { onSignal: (data) => this.sig.signal(peerId, data) });
    entry.peer = peer;
    // No live video (no source chosen yet, or paused): tell them BEFORE the offer so they land on
    // the paused screen instead of flashing 'live'.
    if (!this.videoLive()) this.sig.signal(peerId, { control: 'pause' });
    void peer
      .offer(out, { maxBitrateKbps: this.quality.bitrate * 1000 }) // raises the SDP start/min-bitrate
      .then(() => {
        this.applyVideoQualityTo(entry);
        const h = this.capHeight();
        if (h) this.sig.signal(peerId, { height: h }); // announce the tier ceiling to the new viewer
      })
      .catch(() => {});
  }

  /** Are viewers currently receiving live video? False with no source or while paused. */
  private videoLive(): boolean {
    return !!this.stream && !this.paused;
  }

  private togglePause = async (): Promise<void> => {
    this.paused = !this.paused;
    await this.pushOutgoing(); // rebuild outgoing (video gated by `paused`) + hot-swap all peers
    for (const peerId of this.viewers.keys()) this.sig.signal(peerId, { control: this.paused ? 'pause' : 'resume' });
    this.renderPause();
  };

  private renderPause(): void {
    el('host-paused').hidden = !this.paused;
    el('host-video').hidden = this.paused;
    el('host-stage-meta').hidden = this.paused;
    el('host-live-badge').hidden = this.paused;
    el('host-paused-badge').hidden = !this.paused;
    el('pause-icon').hidden = this.paused; // two bars when live
    el('play-icon').hidden = !this.paused; // triangle when paused (resume)
    setText('pause-label', this.paused ? 'Resume' : 'Pause');
  }

  // --- quality application ---

  // Applies the host cap AND this viewer's requested tier (the more aggressive downscale wins).
  private applyVideoQualityTo(entry: ViewerEntry): void {
    if (!entry.peer) return;
    // Re-read the height at apply time: getSettings().height can be 0 right after capture.
    const height = this.stream?.getVideoTracks()[0]?.getSettings().height ?? 0;
    void entry.peer.setVideoParameters({
      maxBitrate: maxBitrateBps(this.quality.bitrate),
      scaleResolutionDownBy: effectiveScale(height, this.quality.resolution, entry.tier),
      degradationPreference: degradationFor(this.quality),
    });
  }

  private applyVideoQualityAll(): void {
    for (const entry of this.viewers.values()) this.applyVideoQualityTo(entry);
  }

  // The tier ceiling a viewer may pick = the host's outgoing height (source capped by the host's
  // own resolution setting). Announced to viewers so their tier list is stable — they can't infer
  // it from the received video, which ramps up with bandwidth estimation.
  private capHeight(): number {
    const src = this.sourceHeight();
    return src ? Math.min(src, this.quality.resolution) : 0;
  }

  private sourceHeight(): number {
    return this.stream?.getVideoTracks()[0]?.getSettings().height || el<HTMLVideoElement>('host-video').videoHeight;
  }

  // Once we know the source height: clamp the resolution cap to what the source can fill (so the
  // active tier is a visible button, not a hidden 4K/2K above the source), re-apply, announce.
  private onSourceReady = (): void => {
    this.clampResolution();
    this.applyVideoQualityAll();
    this.broadcastHeight();
    this.renderSettings();
  };

  /** Recompute the effective cap from what the host asked for and what the source can fill.
   *
   *  DERIVED, not stepped down in place. The old version only ever lowered — it compared against
   *  the already-clamped value — so sharing a 900px window and then switching to a 4K screen left
   *  the cap stuck at 720 for the rest of the session, with nothing on screen to explain it and
   *  (once settings persisted) a stored value that was more correct than the live one. Reading
   *  `pickedResolution` each time makes that class of bug impossible: `quality.resolution` is
   *  always exactly `min(asked, what the source can fill)`. */
  private clampResolution(): void {
    const src = this.sourceHeight();
    const cap = src ? sourceTier(src) : this.pickedResolution; // no source yet → nothing to cap to
    this.quality = { ...this.quality, resolution: Math.min(this.pickedResolution, cap) as ResolutionTarget };
  }

  private broadcastHeight(): void {
    const h = this.capHeight();
    if (!h) return;
    for (const peerId of this.viewers.keys()) this.sig.signal(peerId, { height: h });
  }

  private applyFps(): void {
    const video = this.stream?.getVideoTracks()[0];
    void video?.applyConstraints({ frameRate: { ideal: this.quality.fps } }).catch(() => {});
  }

  // --- settings modal ---

  private wireSettings(): void {
    const signal = this.ac.signal;
    const open = this.openSettings;
    el('btn-settings').addEventListener('click', open, { signal });
    el('chip-resolution').addEventListener('click', open, { signal });
    el('chip-fps').addEventListener('click', open, { signal });
    el('chip-bitrate').addEventListener('click', open, { signal });
    el('btn-settings-close').addEventListener('click', this.closeSettings, { signal });
    el('btn-settings-done').addEventListener('click', this.closeSettings, { signal });
    // The native `close` event, not the buttons: it also covers Escape and the scrim, which used
    // to be a real leak — Escape never ran closeSettings, so the window titles stayed in the DOM.
    // Cleanup only; the settings are saved elsewhere (see onSettingsClosed for why they must be).
    el('settings-modal').addEventListener('close', this.onSettingsClosed, { signal });
    el('settings-modal').addEventListener(
      'click',
      (e) => {
        if (e.target === el('settings-modal')) this.closeSettings();
      },
      { signal },
    );
    el('btn-modal-source').addEventListener('click', this.chooseSource, { signal });
    for (const b of document.querySelectorAll<HTMLElement>('#settings-modal [data-preset]'))
      b.addEventListener('click', () => this.applyPresetChoice(b.dataset.preset as PresetName), { signal });
    for (const b of document.querySelectorAll<HTMLElement>('#settings-modal [data-res]'))
      b.addEventListener('click', () => this.setResolution(parseRes(b.dataset.res ?? 'source')), { signal });
    for (const b of document.querySelectorAll<HTMLElement>('#settings-modal [data-fps]'))
      b.addEventListener('click', () => this.setFps(Number(b.dataset.fps)), { signal });
    // `input` fires at the pointer's rate during a drag (~60-120/s): put only the label there.
    // `setBitrate` runs on `change`, which fires only on release (or keyboard commit) — otherwise
    // every pixel of drag costs one `setParameters()` PER viewer (a round-trip into the encoder,
    // the only host path that scales with the mesh) + a full `renderSettings()`.
    const bitrate = el<HTMLInputElement>('bitrate-range');
    bitrate.addEventListener('input', (e) => setText('bitrate-value', `${(e.target as HTMLInputElement).value} mbps`), {
      signal,
    });
    bitrate.addEventListener('change', (e) => this.setBitrate(Number((e.target as HTMLInputElement).value)), { signal });
    el('toggle-sysaudio').addEventListener('click', () => void this.toggleSystemAudio(), { signal });
    el('toggle-mic').addEventListener('click', () => void this.toggleMic(), { signal });
  }

  private openSettings = (): void => {
    this.renderSettings(); // fill state (incl. aria-pressed) before the dialog enters the a11y tree
    const modal = el<HTMLDialogElement>('settings-modal');
    if (!modal.open) modal.showModal(); // showModal, not show(): focus trap + Escape + inert background
    void this.renderAudioApps(); // async (a ~240 ms process listing) — the panel opens without it
  };
  private closeSettings = (): void => {
    const modal = el<HTMLDialogElement>('settings-modal');
    if (modal.open) modal.close(); // everything else happens in onSettingsClosed
  };

  /** The two buttons, the scrim, and Escape. NOT destroy(), and that is the point: `close` is
   *  dispatched asynchronously, and destroy() runs `modal.close()` then `ac.abort()`, which
   *  unregisters this listener before the queued event can fire. So this is cleanup only —
   *  hanging the settings save here dropped them every time the host left the room. */
  private onSettingsClosed = (): void => {
    // Window titles are documents and chat subjects, painted on a screen that is being shared
    // full-screen. They have no reason to outlive the panel.
    el('audio-apps-list').replaceChildren();
  };

  private applyPresetChoice(name: PresetName): void {
    this.quality = applyPreset(this.quality, name);
    this.pickedResolution = this.quality.resolution; // record the ask, before the clamp rewrites it
    this.clampResolution(); // a preset may set 4K/2K above the current source
    const video = this.stream?.getVideoTracks()[0];
    if (video) video.contentHint = contentHintFor(this.quality);
    this.applyFps();
    this.applyVideoQualityAll();
    this.broadcastHeight(); // preset may change the resolution cap
    this.renderSettings();
  }

  private setResolution(target: ResolutionTarget): void {
    this.quality = { ...this.quality, preset: null };
    this.pickedResolution = target;
    this.clampResolution(); // the ask is `target`; what lands is that capped by the source
    this.applyVideoQualityAll();
    this.broadcastHeight(); // cap changed → viewers refresh their tier ceiling
    this.renderSettings();
  }

  private setFps(fps: number): void {
    this.quality = { ...this.quality, fps, preset: null };
    this.applyFps();
    this.applyVideoQualityAll(); // degradation follows the (now manual) preset
    this.renderSettings();
  }

  private setBitrate(mbps: number): void {
    this.quality = { ...this.quality, bitrate: mbps, preset: null };
    this.applyVideoQualityAll();
    this.renderSettings();
  }

  private toggleSystemAudio = async (): Promise<void> => {
    this.quality = { ...this.quality, systemAudio: !this.quality.systemAudio };
    // No point running WASAPI clients for audio nobody receives. Turning it back on starts from
    // "viewers hear everything": the ticks are not remembered across the toggle, because they are
    // read from the live capture and there no longer is one. Deliberate — an intent kept aside
    // just to survive this is exactly the second source of truth that can drift out of step.
    if (!this.quality.systemAudio && this.live) return void (await this.sendAudio(null));
    this.markAudioRows(); // the rows lock/unlock with system audio
    await this.pushOutgoing();
    this.renderSettings();
  };

  // --- per-app audio (desktop only) ---

  /** Tick or untick one app. The intent is read back off the live capture rather than stored, so
   *  there is nothing that can fall out of step with it between two clicks. */
  private toggleAudioApp = async (name: string): Promise<void> => {
    const spec = this.live?.spec ?? null;
    const names = audioRowNames(this.audioApps, spec);
    const muted = new Set(names.filter((n) => !isAudible(spec, n)));
    if (!muted.delete(name)) muted.add(name);
    await this.sendAudio(audioSpecFor(names, muted));
  };

  /** Hand one spec to the shell and record what actually came back. */
  private sendAudio = async (spec: AudioSpec | { sourceId: string }): Promise<void> => {
    const native = window.native;
    if (!native) return;
    // Rows stay clickable during the round trip. Without this, a first call that resolves to
    // nothing (app quit) can land AFTER a second that succeeded and wipe its state: the panel
    // would say nothing is muted while the shell is actively capturing.
    const mine = ++this.audioSeq;
    let got: NativeCapturedApp[] | null;
    try {
      got = await native.setAudioCapture(spec);
    } catch {
      got = null;
    }
    if (mine !== this.audioSeq || this.ac.signal.aborted) return;
    // A non-null spec answered with null is a refusal — the app quit, the addon failed to load.
    // The shell resolves everything BEFORE it stops what is running, so the previous capture is
    // untouched and `live` must stay exactly as it was. (`[]` is not a refusal: it is a live
    // capture of nothing, which is how "mute every app" reaches viewers as silence.)
    this.audioFailed = !!spec && !got;
    // Normalised through what actually started, not what was asked: a window pick is stored as
    // "include that app" so one rule renders every mode, and an include whose app quit before
    // start() must not leave its box ticked.
    if (spec && got) this.live = { spec: 'exclude' in spec ? spec : { include: got.map((g) => g.name) }, sessions: got };
    else if (!spec) this.live = null; // an explicit stop; a refusal leaves `live` alone
    // Asking for "this app alone" and silently getting everything is the worst outcome here, so
    // say it. MainWindowHandle names one window per process: a second top-level window (a Chrome
    // popout, a second editor) has no owner to resolve.
    this.audioNoOwner = !!spec && 'sourceId' in spec && !got;

    if (this.live && !this.offAudioChunk) {
      this.offAudioChunk = native.onAudioChunk((key, chunk) => this.nativeAudio.push(key, chunk));
    } else if (!this.live && this.offAudioChunk) {
      this.offAudioChunk();
      this.offAudioChunk = null;
      this.nativeAudio.teardown();
    }
    this.markAudioRows(); // in place: re-listing would cost a ~240 ms process spawn per click
    await this.pushOutgoing(); // rebuild with the other system track + hot-swap every viewer
    this.renderSettings();
  };

  /** Reflect the LIVE capture onto the rows already in the DOM, and lock them when native audio
   *  would do nothing — with system audio off, or before a source exists, buildOutgoing never
   *  reaches the native track, so a capture would be pure waste behind a UI claiming otherwise. */
  private markAudioRows(): void {
    const usable = this.quality.systemAudio && !!this.stream;
    const spec = this.live?.spec ?? null;
    for (const row of document.querySelectorAll<HTMLButtonElement>('#audio-apps-list [data-app]')) {
      const audible = isAudible(spec, row.dataset.app ?? '');
      row.dataset.active = String(audible);
      row.setAttribute('aria-pressed', String(audible));
      row.disabled = !usable;
      row.classList.toggle('pointer-events-none', !usable);
      row.classList.toggle('opacity-40', !usable);
    }
    setText('audio-apps-hint', this.audioHint(usable));
  }

  private audioHint(usable: boolean): string {
    if (!usable) return this.stream ? 'turn system audio on to change this' : 'pick a source first';
    if (this.audioNoOwner) return AUDIO_NO_OWNER;
    if (this.audioFailed) return AUDIO_FAILED;
    // Off the live spec, not off a count of ticks: those two disagree whenever a muted app has
    // since quit, and a warning that cries wolf is a warning nobody reads.
    return this.live && 'include' in this.live.spec ? AUDIO_SNAPSHOT : AUDIO_HINT;
  }

  /** (Re)draw the audio rows. */
  private async renderAudioApps(): Promise<void> {
    const native = window.native;
    if (!native) return;
    show(el('audio-apps-section'));
    // The host DOM is reused across sessions and openings: without this, the previous list stays
    // on screen for the ~240 ms of the listing, with its old ticks and its click listeners already
    // dead (they went with the previous AbortController).
    el('audio-apps-list').replaceChildren();
    setText('audio-apps-hint', AUDIO_HINT);
    let apps: NativeAudioApp[];
    try {
      apps = await native.listAudioApps();
    } catch {
      setText('audio-apps-hint', 'could not list running apps');
      return;
    }
    if (this.ac.signal.aborted) return;
    this.audioApps = apps.map((a) => a.name);

    // A captured app that RESTARTED (Discord auto-updates itself) moved pid, so its session points
    // at a dead one and the mute quietly stopped working. Re-send the very same spec — never a
    // re-derivation, which could resolve a different instance. An app that merely left the listing
    // is NOT stale: minimising Discord to tray drops it from `Get-Process | Where MainWindowHandle`
    // while its process, and its session, carry on perfectly well.
    const moved = (s: NativeCapturedApp): boolean => {
      const now = apps.find((a) => a.name === s.name);
      return now !== undefined && now.pid !== s.pid;
    };
    if (this.live?.sessions.some(moved)) void this.sendAudio(this.live.spec);

    const tpl = el<HTMLTemplateElement>('tpl-audio-app').content.firstElementChild;
    if (!tpl) throw new Error('stream-share: empty #tpl-audio-app');
    const titles = new Map(apps.map((a) => [a.name, a.title]));
    el('audio-apps-list').replaceChildren(
      ...audioRowNames(this.audioApps, this.live?.spec ?? null).map((name) => {
        const node = tpl.cloneNode(true) as HTMLElement;
        node.dataset.app = name; // the key markAudioRows renders from
        // The hint explains why a locked row is locked; without this the row is just dead.
        node.setAttribute('aria-describedby', 'audio-apps-hint');
        hook(node, 'icon').textContent = initials(name);
        hook(node, 'name').textContent = name;
        hook(node, 'note').textContent = titles.get(name) || 'no open window';
        // No aria-label: the row's own text names the app, and aria-pressed carries "heard by
        // viewers". A label would have to restate the state and could then contradict it.
        node.addEventListener('click', () => void this.toggleAudioApp(name), { signal: this.ac.signal });
        return node;
      }),
    );
    this.markAudioRows();
  }

  private toggleMic = async (): Promise<void> => {
    this.quality = { ...this.quality, mic: !this.quality.mic };
    await this.pushOutgoing(); // buildOutgoing self-heals a denied mic (reverts the flag)
    this.renderSettings();
  };

  private renderSettings(): void {
    // The one save site, and it is here because it is synchronous and unconditional: every path
    // that changes a setting repaints the panel, so nothing can change without being written. The
    // dialog's `close` event cannot do this job — see onSettingsClosed.
    //
    // Two non-user-driven mutations reach here, and both are handled rather than absent:
    //   - clampResolution lowers the cap to fit the source, which is why `pickedResolution` and
    //     not `quality.resolution` is what goes to storage;
    //   - buildOutgoing drops `mic` when the permission is denied (reachable from setStream and
    //     sendAudio) — harmless ONLY because serializeQuality never writes `mic`. If mic ever
    //     becomes persisted, this save has to move to the individual setters.
    saveQuality({ ...this.quality, resolution: this.pickedResolution });
    markActive('[data-preset]', 'preset', this.quality.preset);
    markActive('[data-res]', 'res', String(this.quality.resolution));
    markActive('[data-fps]', 'fps', String(this.quality.fps));
    el<HTMLInputElement>('bitrate-range').value = String(this.quality.bitrate);
    setText('bitrate-value', `${this.quality.bitrate} mbps`);
    el('toggle-sysaudio').dataset.active = String(this.quality.systemAudio);
    el('toggle-sysaudio').setAttribute('aria-pressed', String(this.quality.systemAudio));
    el('toggle-mic').dataset.active = String(this.quality.mic);
    el('toggle-mic').setAttribute('aria-pressed', String(this.quality.mic));

    // Fixed 4K·2K·1080p·720p·480p ladder: hide tiers ABOVE the source (can't upscale); the
    // highest remaining tier is the native resolution.
    const src = this.sourceHeight();
    for (const b of document.querySelectorAll<HTMLElement>('#settings-modal [data-res]')) {
      b.hidden = src > 0 && Number(b.dataset.res) > src;
    }

    const resolutionLabel = resLabel(this.quality.resolution);
    this.refreshUploadEstimate();
    setText('est-res', resolutionLabel);
    setText('est-fps', String(this.quality.fps));
    setText('chip-resolution', resolutionLabel);
    setText('chip-fps', `${this.quality.fps} fps`);
    setText('chip-bitrate', `${this.quality.bitrate} mbps`);
    const label = this.stream?.getVideoTracks()[0]?.label;
    setText('settings-source-hint', label || 'no source selected');
    setText('btn-modal-source', this.stream ? 'Change source' : 'Choose source');
  }

  // --- signaling / viewers ---

  private onMessage = (msg: ServerMessage): void => {
    switch (msg.type) {
      case 'peer-joined':
        this.addViewer(msg.peerId, msg.pseudo);
        break;
      case 'signal': {
        const entry = this.viewers.get(msg.from);
        if (!entry) break;
        if (isQualityRequest(msg.data)) {
          entry.tier = msg.data.quality; // viewer picked a quality tier → apply on its sender
          this.applyVideoQualityTo(entry);
        } else if (entry.peer) {
          // A malformed SDP from a (hostile or broken) viewer rejects accept; swallow it so it
          // doesn't surface as an unhandled rejection on the host tab. One bad peer stays local.
          entry.peer.accept(msg.data as PeerSignal).catch(() => {});
        }
        break;
      }
      case 'peer-left':
        this.removeViewer(msg.peerId);
        break;
      case 'reclaimed':
        this.reconcile(msg.iceServers, msg.viewers);
        break;
      case 'reclaim-error':
        this.stop(); // grace window elapsed — the room is gone
        break;
    }
  };

  // After a reclaim: refresh the ICE config and reconcile the roster against the server's
  // truth — offer to viewers that joined during the outage, drop those that left. Viewers
  // still present kept their direct P2P link (media survives a signaling blip).
  private reconcile(iceServers: RTCIceServer[], viewers: RoomViewer[]): void {
    this.config = { iceServers };
    const { toRemove, toAdd } = reconcileRoster(this.viewers.keys(), viewers);
    // These DO notify. The diff is against the server's truth, so it is empty unless somebody
    // genuinely came or went while we were offline — viewers keep their direct P2P link across a
    // blip, which is why a reconnect on its own moves nobody. Suppressing them would silence the
    // one moment the host has no other way to find out; the shared `tag` in notify() collapses a
    // long-outage burst into a single toast.
    for (const peerId of toRemove) this.removeViewer(peerId);
    for (const v of toAdd) this.addViewer(v.peerId, v.pseudo);
  }

  private onStatus = (status: ConnectionStatus): void => {
    if (status === 'reconnecting') {
      this.wasReconnecting = true;
    } else if (status === 'open' && this.wasReconnecting) {
      this.wasReconnecting = false;
      this.sig.reclaim(this.code, this.hostToken); // regain the room (and our peerId)
    }
  };

  /** A native toast, desktop only.
   *
   *  Two gates. `window.native` keeps the web build silent — a browser tab would have to beg for
   *  permission first, and "someone joined" is not worth a prompt. Focus is the feature itself:
   *  the host is meant to learn this while they are in their game.
   *
   *  Note what focus-gating does NOT do — it does not limit the blast radius, it selects for it.
   *  An unfocused host is usually one whose screen is being watched by the whole room, so every
   *  toast is painted into the stream, viewer pseudonym included. Accepted (the sidebar already
   *  shows those names), and the reason the event list is kept as short as it is.
   *
   *  Measured on the shell: under app:// the permission is already `granted`, no request needed
   *  (Electron maps this to a Windows toast, which needs the AppUserModelId set in main.ts). */
  private notify(text: string): void {
    if (!window.native || document.hasFocus()) return;
    try {
      // One shared tag: a flaky viewer reconnecting five times replaces its own toast instead of
      // leaving five to sweep out of the Windows notification centre.
      new Notification(text, { tag: 'ss-viewers' });
    } catch {
      // No Notification constructor at all. Never worth breaking a join over.
    }
  }

  private addViewer(peerId: string, pseudo: string): void {
    if (this.viewers.has(peerId)) return;
    const tpl = el<HTMLTemplateElement>('tpl-viewer-row');
    const first = tpl.content.firstElementChild;
    if (!first) throw new Error('stream-share: empty #tpl-viewer-row');
    const row = first.cloneNode(true) as HTMLElement;
    hook(row, 'initials').textContent = initials(pseudo);
    hook(row, 'name').textContent = pseudo;
    const signal = this.ac.signal;
    const kickBtn = hook(row, 'kick');
    const banBtn = hook(row, 'ban');
    // Name the target: three identical "kick" buttons in the a11y tree are indistinguishable.
    kickBtn.setAttribute('aria-label', `Kick ${pseudo}`);
    banBtn.setAttribute('aria-label', `Ban ${pseudo}`);
    kickBtn.addEventListener('click', () => this.kick(peerId, false), { signal });
    banBtn.addEventListener('click', () => this.kick(peerId, true), { signal });
    el('viewers-list').append(row);
    const entry: ViewerEntry = { pseudo, row, peer: null, tier: 'auto' };
    this.viewers.set(peerId, entry);
    this.offerTo(peerId, entry); // always offer — no source yet just means a paused (waiting) viewer
    this.refreshSidebar();
    this.notify(`${pseudo} joined your stream`);
  }

  private kick(peerId: string, ban: boolean): void {
    if (ban) this.sig.ban(peerId);
    else this.sig.kick(peerId);
    this.removeViewer(peerId, true); // silent: we just did this on purpose, a toast is noise
  }

  /** `silent` exists for exactly one caller: kick(), where the host just did this on purpose. */
  private removeViewer(peerId: string, silent = false): void {
    const entry = this.viewers.get(peerId);
    if (!entry) return;
    if (!silent) this.notify(`${entry.pseudo} left your stream`);
    entry.peer?.close();
    entry.row.remove();
    this.viewers.delete(peerId);
    this.refreshSidebar();
  }

  private refreshSidebar(): void {
    setText('viewer-count', String(this.viewers.size));
    const has = this.viewers.size > 0;
    el('viewers-list').hidden = !has;
    el('host-waiting').hidden = has;
    this.refreshUploadEstimate(); // the estimate scales with viewer count (mesh); keep it live on join/leave
  }

  // Just the upload estimate, split out of renderSettings so a viewer joining/leaving refreshes it
  // without re-running the whole panel (which would snap the bitrate slider back mid-drag).
  private refreshUploadEstimate(): void {
    setText('est-upload', String(estimatedUpload(this.quality, this.viewers.size)));
  }

  private copyLink = async (): Promise<void> => {
    // Desktop shell: share the real web origin, not the app:// one (window.native absent in a browser).
    const origin = window.native?.appOrigin ?? location.origin;
    const link = `${origin}/#${this.code}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // clipboard blocked (insecure context: HTTP on a LAN IP is exactly the local-test case).
      // A button labelled "Copy room link" that does nothing reads as broken — say it failed.
      this.flashCopied(false);
      return;
    }
    this.flashCopied(true);
  };

  // Confirm the copy on both entry points: the top-bar chip label and the sidebar button
  // (data-copied drives its green flash). Single timer so rapid re-clicks don't revert early.
  private flashCopied(ok: boolean): void {
    setText('copy-label', ok ? 'copied ✓' : 'copy failed');
    const waiting = el('btn-copy-link-waiting');
    waiting.textContent = ok ? 'Copied ✓' : 'Copy failed';
    waiting.dataset.copied = String(ok); // green flash only on success
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => {
      setText('copy-label', 'copy link');
      waiting.textContent = 'Copy room link';
      waiting.dataset.copied = 'false';
    }, 1600);
  }

  // Stop the current source but KEEP the room and peers alive: viewers fall back to the paused
  // (waiting) screen and the host returns to "choose source", able to pick a new source without
  // recreating the room. Wired to the Stop button and the track's `ended` (browser "Stop sharing",
  // or the shared window closing). Leaving the room for good goes through the brand logo (goHome).
  private stopSource = (): void => {
    if (!this.stream) return; // already sourceless
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.paused = false; // a fresh source starts live, not paused
    // Same rule as turning system audio off: no WASAPI client for audio nobody receives. With no
    // source, buildOutgoing drops the audio entirely, so the sessions would just burn native
    // threads and ~100 IPC messages a second each for nothing. The ticks go with them: the next
    // source starts from "viewers hear everything".
    if (this.live) void this.sendAudio(null);
    // Pause the viewers now (synchronous); the rebuild's replaceTrack(null) that drops their video +
    // audio can follow async — unlike togglePause we don't await it, the paused screen is immediate.
    void this.pushOutgoing();
    for (const peerId of this.viewers.keys()) this.sig.signal(peerId, { control: 'pause' });
    this.resetStage();
    // AFTER resetStage, which clears the preview: sourceHeight() reads that element as a fallback,
    // so clamping any earlier would just re-derive the cap of the source we are dropping. With no
    // source there is nothing to cap against, and the panel goes back to showing what was asked for.
    this.clampResolution();
    this.renderSettings(); // "Choose source" label + "no source selected" hint
  };

  // Reset only the stage to the "no source" empty state (preview, badges, control buttons).
  // NOT the roster / code / copy / modal — stopSource reuses this and must keep viewers + room alive.
  private resetStage(): void {
    const preview = el<HTMLVideoElement>('host-video');
    preview.srcObject = null;
    hide(preview);
    show(el('host-empty'));
    hide(el('host-stage-meta'));
    hide(el('host-live-badge'));
    hide(el('host-paused'));
    hide(el('host-paused-badge'));
    hide(el('btn-stop'));
    hide(el('btn-pause'));
    hide(el('host-quality-bar'));
  }

  private stop = (): void => {
    this.destroy();
    this.onEnd();
  };

  /** Tear down media, peers and subscriptions without navigating. */
  destroy(): void {
    // A modal <dialog> lives in the top layer: hiding the host section wouldn't dismiss it, so a
    // stale settings panel would sit over the next screen. (Reachable via Escape mid-teardown.)
    const modal = el<HTMLDialogElement>('settings-modal');
    if (modal.open) modal.close();
    this.ac.abort(); // remove all DOM listeners
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.wakeLock.release();
    this.offMessage();
    this.offStatus();
    for (const entry of this.viewers.values()) entry.peer?.close();
    this.viewers.clear();
    this.mixer.teardown();
    // A native capture keeps its WASAPI clients and an IPC listener alive across sessions; the
    // AbortController above doesn't reach either.
    this.offAudioChunk?.();
    this.offAudioChunk = null;
    this.nativeAudio.teardown();
    // Unconditional, not `if (this.live)`: a capture requested seconds ago may still be resolving
    // in main, in which case `live` is null here and the sessions would start after we are gone
    // and never stop. IPC is ordered, so this null reaches the handler first and cancels it.
    void window.native?.setAudioCapture(null);
    this.live = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.outgoing = null;
  }
}

/** Storage is best-effort on both sides: `localStorage` throws outright in some private-browsing
 *  modes and on quota, and a settings panel is never worth taking a live share down for. */
function loadQuality(): Quality {
  try {
    return parseQuality(localStorage.getItem(QUALITY_KEY));
  } catch {
    return { ...DEFAULT_QUALITY };
  }
}

function saveQuality(q: Quality): void {
  try {
    localStorage.setItem(QUALITY_KEY, serializeQuality(q));
  } catch {
    /* nothing to recover: the session keeps working, it just won't be remembered */
  }
}

/** Default text under "Per-app audio" — restored on each open so one transient listing failure
 *  doesn't leave its error sitting above a perfectly good list for the rest of the session. */
const AUDIO_HINT = 'only apps with an open window are listed';
/** Replaces it whenever the live capture is an inclusion, which no longer follows the machine.
 *  Not a detail: the host is told, in the panel, exactly while it is true. */
const AUDIO_SNAPSHOT = 'only the ticked apps are sent — anything started later is silent until you tick it';
/** Shown when a shared window has no resolvable owning process — see sendAudio. */
const AUDIO_NO_OWNER = "this window has no app audio of its own — sharing all system sound";
/** A click the shell turned down. Whatever was running still is, so the boxes are still true. */
const AUDIO_FAILED = 'that change did not take — the app may have quit; nothing else was altered';

/** A capture the shell is running. */
export type LiveSpec = { exclude: string } | { include: string[] };
/** What to ask the shell to capture. `null` = nothing native, use the ordinary loopback track. */
export type AudioSpec = LiveSpec | null;

/** Whether viewers hear `name` under the capture that is actually running. The single rule every
 *  checkbox renders from — no stored intent to drift away from it. */
export function isAudible(spec: LiveSpec | null, name: string): boolean {
  if (!spec) return true; // the loopback track carries the whole machine
  if ('exclude' in spec) return name !== spec.exclude;
  return spec.include.includes(name); // an app not in the set has no session, so no sound
}

/** Which rows to draw: the listing, plus any app the live capture names that has dropped out of
 *  it. Minimising Discord to tray removes it from `Get-Process | Where MainWindowHandle` while its
 *  exclusion keeps running — losing the row would leave the host no way to see or undo the mute. */
export function audioRowNames(apps: readonly string[], spec: LiveSpec | null): string[] {
  const named = !spec ? [] : 'exclude' in spec ? [spec.exclude] : spec.include;
  return [...apps, ...named.filter((n) => !apps.includes(n))];
}

/**
 * Turn the checkboxes into a capture spec: which of `apps` the host unchecked → what the shell
 * should run.
 *
 * Nothing muted → `null`: the loopback track already carries everything, for free.
 *
 * Exactly one muted → exclusion, and the special case earns its keep. Exclusion is the only mode
 * that keeps up with the machine: apps with no window, Windows' own sounds and anything launched
 * after the capture started are all still heard. Inclusion can't do that — its list is a snapshot.
 * So the common case (mute the voice client) stays on the mode with no blind spot.
 *
 * Two or more → WASAPI takes a single process tree per mode, so the mix has to be rebuilt from the
 * other side: one include session per app left ticked.
 *
 * Every app muted → `{ include: [] }`, NEVER `null`. Returning null there would mean "use the
 * loopback track", which un-mutes every app the host just muted — the worst possible outcome
 * reached by the most natural gesture. An empty include is a live capture of nothing: silence.
 *
 * A muted name that is no longer running is ignored: there is nothing left to silence, and
 * counting it would push a one-app mute into inclusion for no reason.
 */
export function audioSpecFor(apps: readonly string[], muted: ReadonlySet<string>): AudioSpec {
  const live = apps.filter((a) => muted.has(a));
  if (live.length === 0) return null;
  if (live.length === 1) return { exclude: live[0] };
  return { include: apps.filter((a) => !muted.has(a)) };
}

export function parseRes(v: string): ResolutionTarget {
  return Number(v) as ResolutionTarget;
}

// A viewer's quality-tier request, relayed as opaque `data` over `signal` (distinct from SDP/ICE).
// The value comes from an untrusted peer → validate against the allowed set (a bad value would
// otherwise reach scaleResolutionDownBy as Infinity/NaN and break that viewer's sender).
const QUALITY_TIERS = new Set<ViewerTier>(['auto', 'source', 1440, 1080, 720, 480]);
export function isQualityRequest(data: unknown): data is { quality: ViewerTier } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'quality' in data &&
    QUALITY_TIERS.has((data as { quality: ViewerTier }).quality)
  );
}

function markActive(selector: string, attr: string, value: string | null): void {
  for (const btn of document.querySelectorAll<HTMLElement>(`#settings-modal ${selector}`)) {
    const active = btn.dataset[attr] === value;
    btn.dataset.active = String(active); // visual
    btn.setAttribute('aria-pressed', String(active)); // exposed to a screen reader
  }
}
