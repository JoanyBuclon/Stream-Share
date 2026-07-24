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
import { el, show, hide, setText, initials } from './dom.ts';
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
    const preview = el<HTMLVideoElement>('host-video');
    preview.srcObject = null;
    hide(preview);
    show(el('host-empty'));
    hide(el('host-stage-meta'));
    hide(el('host-live-badge'));
    hide(el('btn-stop'));
    hide(el('btn-pause'));
    hide(el('host-paused'));
    hide(el('host-paused-badge'));
    hide(el('host-quality-bar'));
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
    // Empty-state "Choose source" opens the settings modal (pick source + tune quality there);
    // the control-bar "Change source" is a direct quick re-pick.
    el('btn-choose-source').addEventListener('click', this.openSettings, { signal });
    el('btn-pause').addEventListener('click', () => void this.togglePause(), { signal });
    el('btn-resume').addEventListener('click', () => void this.togglePause(), { signal });
    // Once the preview knows its real dimensions: clamp the cap, re-apply, announce to viewers.
    el('host-video').addEventListener('loadedmetadata', this.onSourceReady, { signal });
    el('btn-stop').addEventListener('click', this.stop, { signal });
    el('btn-copy-link').addEventListener('click', this.copyLink, { signal });
    el('btn-copy-link-waiting').addEventListener('click', this.copyLink, { signal });
    this.wireSettings();
    this.renderSettings();

    this.offMessage = sig.onMessage(this.onMessage);
    this.offStatus = sig.onStatus(this.onStatus);
    void this.wakeLock.request();
  }

  // --- source capture ---

  private chooseSource = async (): Promise<void> => {
    const constraints: DisplayMediaStreamOptions = {
      video: { frameRate: { ideal: this.quality.fps } },
      // Left to its defaults, the browser runs its voice-tuned processing (AGC / noise suppression /
      // echo cancellation) on tab & screen audio: it downmixes to mono and mangles music and games.
      // Off + explicit stereo 48 kHz = the raw capture. The mic keeps its processing (cf. AudioMixer).
      audio: this.quality.systemAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 }
        : false,
    };
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
      await this.setStream(stream);
    } catch (e) {
      // NotAllowedError = the user dismissed the picker or a policy blocked it: intended, stay
      // silent. The bare catch used to swallow everything, so NotReadableError (source locked by
      // another app), OverconstrainedError, etc. looked identical to a cancel — a genuine failure
      // with no feedback reads as a broken button. Surface those in the existing source hint.
      if (!(e instanceof DOMException) || e.name !== 'NotAllowedError') {
        setText('settings-source-hint', 'capture failed — try another source');
      }
    }
  };

  private setStream = async (capture: MediaStream): Promise<void> => {
    const previous = this.stream;
    this.stream = capture;
    const video = capture.getVideoTracks()[0];
    if (video) {
      video.contentHint = contentHintFor(this.quality);
      video.addEventListener('ended', this.stop, { signal: this.ac.signal }); // "Stop sharing" from the browser chrome
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
      for (const [peerId, entry] of this.viewers) if (!entry.peer) this.offerTo(peerId, entry);
      this.applyVideoQualityAll(); // existing viewers: re-apply with the new source's height
    } finally {
      previous?.getTracks().forEach((t) => t.stop()); // stop the old source even if the rebuild failed
      this.renderSettings();
      this.renderPause(); // a source change during a pause must keep the paused stage/badges
    }
  };

  // Build the stream peers receive: capture video + processed audio (system / mic / mixed / none).
  private async buildOutgoing(): Promise<MediaStream | null> {
    if (!this.stream) return null;
    const out = new MediaStream();
    const video = this.paused ? null : this.stream.getVideoTracks()[0];
    if (video) out.addTrack(video);
    const systemTrack = this.quality.systemAudio ? (this.stream.getAudioTracks()[0] ?? null) : null;
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
    if (!this.outgoing) return;
    const peer = new Peer(this.config, { onSignal: (data) => this.sig.signal(peerId, data) });
    entry.peer = peer;
    // Late joiner during a pause: tell them BEFORE the offer so they never flash 'live'.
    if (this.paused) this.sig.signal(peerId, { control: 'pause' });
    void peer
      .offer(this.outgoing, { maxBitrateKbps: this.quality.bitrate * 1000 }) // relève start/min-bitrate SDP
      .then(() => {
        this.applyVideoQualityTo(entry);
        const h = this.capHeight();
        if (h) this.sig.signal(peerId, { height: h }); // announce the tier ceiling to the new viewer
      })
      .catch(() => {});
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
    // `input` tire à la fréquence du pointeur pendant un drag (~60-120/s) : on n'y met que le
    // libellé. `setBitrate` part sur `change`, qui ne tire qu'au relâchement (ou à la validation
    // clavier) — sinon chaque pixel de drag coûte un `setParameters()` PAR viewer (aller-retour
    // dans l'encodeur, seul chemin du host qui scale avec le mesh) + un `renderSettings()` entier.
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
  };
  private closeSettings = (): void => {
    const modal = el<HTMLDialogElement>('settings-modal');
    if (modal.open) modal.close(); // Escape closes it natively too; this covers the buttons/scrim
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
    await this.pushOutgoing();
    this.renderSettings();
  };

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
          void entry.peer.accept(msg.data as PeerSignal);
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
    const row = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    row.querySelector<HTMLElement>('[data-hook="initials"]')!.textContent = initials(pseudo);
    row.querySelector<HTMLElement>('[data-hook="name"]')!.textContent = pseudo;
    const signal = this.ac.signal;
    const kickBtn = row.querySelector<HTMLElement>('[data-hook="kick"]')!;
    const banBtn = row.querySelector<HTMLElement>('[data-hook="ban"]')!;
    // Name the target: three identical "kick" buttons in the a11y tree are indistinguishable.
    kickBtn.setAttribute('aria-label', `Kick ${pseudo}`);
    banBtn.setAttribute('aria-label', `Ban ${pseudo}`);
    kickBtn.addEventListener('click', () => this.kick(peerId, false), { signal });
    banBtn.addEventListener('click', () => this.kick(peerId, true), { signal });
    el('viewers-list').append(row);
    const entry: ViewerEntry = { pseudo, row, peer: null, tier: 'auto' };
    this.viewers.set(peerId, entry);
    if (this.outgoing) this.offerTo(peerId, entry);
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
    const link = `${location.origin}/#${this.code}`;
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
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.outgoing = null;
  }
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
