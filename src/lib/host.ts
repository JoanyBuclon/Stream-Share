// Host controller: capture a source, open one Peer per viewer (mesh), manage the viewer
// sidebar (per-viewer quality, kick/ban, stats), drive the settings modal (source / quality /
// audio), pause/resume the stream, and reclaim the room after a signaling blip.
// See docs/frontend.md.

import { Signaling, type ServerMessage, type ConnectionStatus, type RoomViewer } from './signaling.ts';
import { Peer, type PeerSignal } from './peer.ts';
import { AudioMixer } from './audio.ts';
import { serial } from './serial.ts';
import { WakeLock } from './wakelock.ts';
import { reconcileRoster } from './roster.ts';
import { el, hook, show, hide, setText, initials } from './dom.ts';
import { pickSource } from './source-picker.ts';
import { NativeAudio } from './native-audio.ts';
import {
  applyPreset,
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
  // The single native capture, if any. One object rather than loose fields: the epoch guard has
  // to reconcile the whole thing across an await, and WASAPI allows one mode at a time anyway.
  private audio: { mode: 'include' | 'exclude'; name: string; pid: number } | null = null;
  private audioSeq = 0; // guards the round trip against a faster second click
  // Sticky: the shared window has no owning process, so app-only sound is impossible for it. Kept
  // as state, not just as text — the pick happens before the panel opens, and opening it resets
  // the hint line.
  private audioNoOwner = false;
  private readonly nativeAudio = new NativeAudio();
  private offAudioChunk: (() => void) | null = null;
  private quality: Quality = { ...DEFAULT_QUALITY };
  private readonly mixer = new AudioMixer();
  private readonly audioQueue = serial(); // serializes outgoing rebuilds — no interleaving
  private readonly wakeLock = new WakeLock(); // keep the screen awake while hosting
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
        // A window shares that app alone; a screen drops back to the system mix (any mute the
        // user had set is re-picked from the panel, rather than silently re-armed).
        void this.setAudio(picked.startsWith('window:') ? { sourceId: picked } : null);
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
    // Excluding an app swaps the source of "system audio": the shell's WASAPI capture (the whole
    // mix minus that app's process tree) instead of the loopback track getDisplayMedia handed us.
    // The loopback track stays alive and simply isn't used — exactly what turning systemAudio off
    // already does — so toggling exclusion never re-runs capture() and never disturbs viewers.
    const systemTrack = !this.quality.systemAudio
      ? null
      : this.audio
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

  private clampResolution(): void {
    const src = this.sourceHeight();
    if (src) {
      const cap = sourceTier(src);
      if (this.quality.resolution > cap) this.quality = { ...this.quality, resolution: cap };
    }
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
    if (modal.open) modal.close(); // Escape closes it natively too; this covers the buttons/scrim
    // Window titles are documents and chat subjects, painted on a screen that is being shared
    // full-screen. They have no reason to outlive the panel.
    el('audio-apps-list').replaceChildren();
  };

  private applyPresetChoice(name: PresetName): void {
    this.quality = applyPreset(this.quality, name);
    this.clampResolution(); // a preset may set 4K/2K above the current source
    const video = this.stream?.getVideoTracks()[0];
    if (video) video.contentHint = contentHintFor(this.quality);
    this.applyFps();
    this.applyVideoQualityAll();
    this.broadcastHeight(); // preset may change the resolution cap
    this.renderSettings();
  }

  private setResolution(target: ResolutionTarget): void {
    this.quality = { ...this.quality, resolution: target, preset: null };
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
    // No point running a WASAPI client for audio nobody receives; setAudio finishes the job.
    if (!this.quality.systemAudio && this.audio) return void (await this.setAudio(null));
    await this.pushOutgoing();
    this.renderSettings();
  };

  // --- per-app audio (desktop only) ---

  /** Point the native capture at something, or stop it with `null`.
   *
   *  `{ sourceId }` — the shared window's app alone. `{ exclude }` — everything but that app.
   *  Only one can be live: WASAPI takes a single process tree, include OR exclude. */
  private setAudio = async (spec: { sourceId: string } | { exclude: string } | null): Promise<void> => {
    const native = window.native;
    if (!native) return;
    // Rows stay clickable during the round trip. Without this, a first call that resolves to
    // nothing (app quit) can land AFTER a second that succeeded and wipe its state: the panel
    // would say nothing is muted while the shell is actively excluding.
    const mine = ++this.audioSeq;
    let got: { pid: number; name: string } | null;
    try {
      got = await native.setAudioCapture(spec);
    } catch {
      got = null; // the shell couldn't start the capture — fall back to the ordinary loopback
    }
    if (mine !== this.audioSeq || this.ac.signal.aborted) return;
    this.audio = spec && got ? { mode: 'sourceId' in spec ? 'include' : 'exclude', ...got } : null;
    // Asking for "this app alone" and silently getting everything is the worst outcome here, so
    // say it. MainWindowHandle names one window per process: a second top-level window (a Chrome
    // popout, a second editor) has no owner to resolve.
    this.audioNoOwner = !!spec && 'sourceId' in spec && !got;
    if (this.audioNoOwner) setText('audio-apps-hint', AUDIO_NO_OWNER);

    if (this.audio && !this.offAudioChunk) {
      this.offAudioChunk = native.onAudioChunk((chunk) => this.nativeAudio.push(chunk));
    } else if (!this.audio && this.offAudioChunk) {
      this.offAudioChunk();
      this.offAudioChunk = null;
      this.nativeAudio.teardown();
    }
    this.markAudioRows(); // in place: re-listing would cost a ~240 ms process spawn per click
    await this.pushOutgoing(); // rebuild with the other system track + hot-swap every viewer
    this.renderSettings();
  };

  /** Reflect the current capture onto the rows already in the DOM, and lock them when native
   *  audio would do nothing — with system audio off, or before a source exists, buildOutgoing
   *  never reaches the native track, so a live capture would be pure waste behind a UI claiming
   *  otherwise. */
  private markAudioRows(): void {
    const usable = this.quality.systemAudio && !!this.stream;
    const current = this.audio;
    for (const row of document.querySelectorAll<HTMLButtonElement>('#audio-apps-list [data-mode]')) {
      const mode = row.dataset.mode;
      const active = current
        ? mode === current.mode && (mode === 'include' || row.dataset.app === current.name)
        : mode === 'none';
      row.dataset.active = String(active);
      row.setAttribute('aria-pressed', String(active));
      row.disabled = !usable;
      row.classList.toggle('pointer-events-none', !usable);
      row.classList.toggle('opacity-40', !usable);
    }
    if (!usable) {
      setText('audio-apps-hint', this.stream ? 'turn system audio on to change this' : 'pick a source first');
    }
  }

  /** (Re)draw the audio rows. Refreshed on every panel open, which is also how a restarted app
   *  (Discord auto-updates) gets its new pid picked up — exclusion is keyed on the name. */
  private async renderAudioApps(): Promise<void> {
    const native = window.native;
    if (!native) return;
    show(el('audio-apps-section'));
    // The host DOM is reused across sessions and openings: without this, the previous list stays
    // on screen for the ~240 ms of the listing, with its old selection highlighted and its click
    // listeners already dead (they went with the previous AbortController).
    el('audio-apps-list').replaceChildren();
    setText('audio-apps-hint', this.audioNoOwner ? AUDIO_NO_OWNER : AUDIO_HINT);
    let apps: NativeAudioApp[];
    try {
      apps = await native.listAudioApps();
    } catch {
      setText('audio-apps-hint', 'could not list running apps');
      return;
    }
    if (this.ac.signal.aborted) return;

    // Re-arm if the muted app restarted (Discord auto-updates itself): its pid moved, and the
    // shell would go on excluding a dead one — the echo would come back with nothing to show for
    // it. Only when the pid actually changed, so opening the panel doesn't churn every viewer.
    const muted = this.audio?.mode === 'exclude' ? this.audio : null;
    if (muted) {
      const still = apps.find((a) => a.name === muted.name);
      if (still?.pid !== muted.pid) void this.setAudio(still ? { exclude: muted.name } : null);
    }

    const tpl = el<HTMLTemplateElement>('tpl-audio-app').content.firstElementChild;
    if (!tpl) throw new Error('stream-share: empty #tpl-audio-app');
    const sourceId = this.sourceId;
    const rows: Array<{ mode: 'include' | 'none' | 'exclude'; app: string; label: string; note: string }> = [];
    // Sharing a window: offer "that app alone". One more row rather than a toggle — the section is
    // already a single-select list, which is exactly the shape of the one-tree API constraint.
    if (sourceId?.startsWith('window:')) {
      rows.push({
        mode: 'include',
        app: '',
        label: this.audio?.mode === 'include' ? `Only ${this.audio.name}'s sound` : "Only the shared app's sound",
        note: 'viewers hear this app alone',
      });
    }
    rows.push({ mode: 'none', app: '', label: 'No app muted', note: 'viewers hear everything' });
    for (const a of apps) rows.push({ mode: 'exclude', app: a.name, label: a.name, note: a.title || 'running' });

    el('audio-apps-list').replaceChildren(
      ...rows.map((row) => {
        const node = tpl.cloneNode(true) as HTMLElement;
        node.dataset.mode = row.mode; // the keys markAudioRows compares against
        node.dataset.app = row.app;
        node.setAttribute(
          'aria-label',
          row.mode === 'include' ? row.label : row.mode === 'exclude' ? `Mute ${row.app} for viewers` : 'Mute no app',
        );
        hook(node, 'icon').textContent = row.mode === 'exclude' ? initials(row.app) : row.mode === 'include' ? '►' : '—';
        hook(node, 'name').textContent = row.label;
        hook(node, 'note').textContent = row.note;
        node.addEventListener(
          'click',
          () =>
            void this.setAudio(
              row.mode === 'include' && sourceId
                ? { sourceId }
                : row.mode === 'exclude'
                  ? { exclude: row.app }
                  : null,
            ),
          { signal: this.ac.signal },
        );
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
  }

  private kick(peerId: string, ban: boolean): void {
    if (ban) this.sig.ban(peerId);
    else this.sig.kick(peerId);
    this.removeViewer(peerId);
  }

  private removeViewer(peerId: string): void {
    const entry = this.viewers.get(peerId);
    if (!entry) return;
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
    // source, buildOutgoing drops the audio entirely, so the capture would just burn a native
    // thread and ~100 IPC messages a second for nothing.
    if (this.audio) void this.setAudio(null);
    // Pause the viewers now (synchronous); the rebuild's replaceTrack(null) that drops their video +
    // audio can follow async — unlike togglePause we don't await it, the paused screen is immediate.
    void this.pushOutgoing();
    for (const peerId of this.viewers.keys()) this.sig.signal(peerId, { control: 'pause' });
    this.resetStage();
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
    // A native capture keeps a WASAPI client and an IPC listener alive across sessions; the
    // AbortController above doesn't reach either.
    this.offAudioChunk?.();
    this.offAudioChunk = null;
    this.nativeAudio.teardown();
    if (this.audio) void window.native?.setAudioCapture(null);
    this.audio = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.outgoing = null;
  }
}

/** Default text under "Per-app audio" — restored on each open so one transient listing failure
 *  doesn't leave its error sitting above a perfectly good list for the rest of the session. */
const AUDIO_HINT = 'only apps with an open window are listed';
/** Shown when a shared window has no resolvable owning process — see setAudio. */
const AUDIO_NO_OWNER = "this window has no app audio of its own — sharing all system sound";

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
