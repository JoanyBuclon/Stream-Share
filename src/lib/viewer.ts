// Viewer controller: a single Peer to the host, stream playback, lifecycle states
// and local-only controls. On a signaling blip it re-joins (new peerId + Peer).
// MVP scope — no quality tiers / stats yet (see docs/frontend.md).

import { Signaling, type ServerMessage, type ConnectionStatus } from './signaling.ts';
import { Peer, type PeerSignal } from './peer.ts';
import { el, show, hide, setText } from './dom.ts';
import { formatCode } from './code.ts';
import { viewerTiers, type ViewerTier } from './settings.ts';
import { readStats, rateStats, type RtcStat, type Sample } from './stats.ts';
import { WakeLock } from './wakelock.ts';

export interface ViewerInit {
  hostId: string;
  iceServers: RTCIceServer[];
}

type ViewerState = 'connecting' | 'live' | 'reconnecting' | 'paused' | 'ended' | 'error';

// Connection-dot colors reference the @theme tokens (single source of truth, cf. app.css).
const DOT = { good: 'var(--color-good)', gold: 'var(--color-gold)', muted: 'var(--color-muted-4)', red: 'var(--color-live)' };

// Host pause/resume travels over the signal relay (opaque `data`), distinct from SDP/ICE.
type PeerControl = { control: 'pause' | 'resume' };
function isControl(data: unknown): data is PeerControl {
  return typeof data === 'object' && data !== null && 'control' in data;
}

// The host announces its cap height (tier ceiling) over the same relay. Validate the value.
function isHeight(data: unknown): data is { height: number } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'height' in data &&
    typeof (data as { height: unknown }).height === 'number' &&
    (data as { height: number }).height > 0
  );
}

function tierLabel(tier: ViewerTier): string {
  return tier === 'auto' ? 'Auto' : tier === 'source' ? 'Source' : `${tier}p`;
}

function parseTier(v: string): ViewerTier {
  return v === 'auto' ? 'auto' : v === 'source' ? 'source' : (Number(v) as 1440 | 1080 | 720 | 480);
}

// If the transport never recovers, stop spinning on "reconnecting" and surface the failure.
// Generous enough to cover the host's capped ICE restarts (a real blip recovers in seconds).
const RECONNECT_TIMEOUT_MS = 20_000;

// Immersive playback: fade the top bar + controls after the mouse sits still this long.
const UI_IDLE_MS = 3_000;

export class ViewerController {
  private readonly sig: Signaling;
  private readonly code: string;
  private readonly pseudo: string;
  private readonly token: string;
  private readonly onLeave: () => void;
  private config: RTCConfiguration;
  private hostId: string;
  private peer: Peer | null = null;
  private everConnected = false;
  private wasReconnecting = false;
  private terminated = false;
  private hostPaused = false; // remembered so an ICE blip during a pause doesn't flip back to 'live'
  private tier: ViewerTier = 'auto'; // requested quality; re-sent on (re)connect so the host stays in sync
  private hostHeight = 0; // host cap height (tier ceiling), announced by the host — NOT inferred from the ramping received video
  private statsOn = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private prevSample: Sample | null = null; // previous getStats sample (for bitrate/loss deltas)
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private uiHideTimer: ReturnType<typeof setTimeout> | null = null;
  private watching = false; // true only while a live stream plays → gate the UI auto-hide
  private readonly ac = new AbortController(); // removes all DOM listeners on destroy()
  private readonly wakeLock = new WakeLock(); // keep the screen awake while watching
  private readonly offMessage: () => void;
  private readonly offStatus: () => void;

  constructor(sig: Signaling, init: ViewerInit, session: { code: string; pseudo: string; token: string }, opts: { onLeave: () => void }) {
    this.sig = sig;
    this.code = session.code;
    this.pseudo = session.pseudo;
    this.token = session.token;
    this.onLeave = opts.onLeave;
    this.config = { iceServers: init.iceServers };
    this.hostId = init.hostId;

    setText('viewer-room-code', formatCode(this.code));
    this.wireControls();
    this.wireAutoHide();
    this.offMessage = sig.onMessage(this.onMessage);
    this.offStatus = sig.onStatus(this.onStatus);

    this.setState('connecting');
    this.buildPeer(init.hostId);
    void this.wakeLock.request();
  }

  private buildPeer(hostId: string): void {
    this.peer?.close();
    this.hostId = hostId;
    this.prevSample = null; // new pc → byte/packet counters reset; drop the old baseline
    this.peer = new Peer(this.config, {
      onSignal: (data) => this.sig.signal(this.hostId, data),
      onTrack: (stream) => {
        el<HTMLVideoElement>('viewer-video').srcObject = stream;
        this.everConnected = true;
        if (this.tier !== 'auto') this.sig.signal(this.hostId, { quality: this.tier }); // resync after (re)connect
        this.showStream();
      },
      onIceState: (state) => this.onIceState(state),
    });
  }

  private onIceState(state: RTCIceConnectionState): void {
    if (this.terminated) return; // session finie (kick / host-left) — ignorer les transitions ICE tardives
    if (state === 'connected' || state === 'completed') {
      this.everConnected = true;
      this.showStream();
    } else if (state === 'disconnected') {
      this.setState('reconnecting'); // transient; the host restarts ICE on 'failed'
    } else if (state === 'failed') {
      // Never connected → the direct P2P path is impossible (e.g. symmetric NAT, no TURN).
      // Was connected → the host will attempt an ICE restart, so stay optimistic.
      this.setState(this.everConnected ? 'reconnecting' : 'error');
    }
  }

  private onMessage = (msg: ServerMessage): void => {
    switch (msg.type) {
      case 'signal': {
        if (msg.from !== this.hostId) break;
        if (isControl(msg.data)) this.onControl(msg.data.control);
        else if (isHeight(msg.data)) {
          this.hostHeight = msg.data.height; // host announced its cap → tier ceiling
          this.renderTiers();
        } else void this.peer?.accept(msg.data as PeerSignal);
        break;
      }
      case 'joined': // fresh join after a reconnect
        this.config = { iceServers: msg.iceServers };
        this.buildPeer(msg.hostId);
        break;
      case 'peer-left': // viewers only ever get the host's departure (room destroyed)
        if (msg.peerId === this.hostId) this.endSession();
        break;
      case 'kicked':
        this.endSession();
        break;
    }
  };

  private onControl(control: 'pause' | 'resume'): void {
    this.hostPaused = control === 'pause';
    this.showStream();
  }

  // Show the stream — but honor a host pause (an ICE (re)connect during a pause stays 'paused').
  private showStream(): void {
    this.setState(this.hostPaused ? 'paused' : 'live');
  }

  // Rebuild the quality-tier buttons from the received video height (fires on the video 'resize'
  // event, so it tracks host resolution changes). Tiers above the host stream never appear.
  private renderTiers(): void {
    if (!this.hostHeight) return; // wait for the host to announce its cap height
    const container = el('viewer-quality');
    container.replaceChildren();
    for (const tier of viewerTiers(this.hostHeight)) {
      const btn = document.createElement('button');
      btn.className = 'ss-tier';
      // "Source" shows the real ceiling height (e.g. 1440p), like the host settings.
      btn.textContent = tier === 'source' ? `${this.hostHeight}p` : tierLabel(tier);
      btn.dataset.tier = String(tier);
      btn.dataset.active = String(tier === this.tier);
      container.append(btn); // clicks handled by a single delegated listener (wireControls)
    }
  }

  private selectTier(tier: ViewerTier): void {
    this.tier = tier;
    this.sig.signal(this.hostId, { quality: tier }); // host applies scaleResolutionDownBy on our sender
    this.renderTiers();
  }

  private toggleStats(): void {
    this.statsOn = !this.statsOn;
    el('btn-stats').dataset.active = String(this.statsOn);
    if (this.statsOn) {
      show(el('viewer-stats'));
      void this.pollStats();
      this.statsTimer = setInterval(() => void this.pollStats(), 1000);
    } else {
      hide(el('viewer-stats'));
      this.stopStats();
    }
  }

  private stopStats(): void {
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.prevSample = null;
  }

  private async pollStats(): Promise<void> {
    try {
      const peer = this.peer;
      const report = await peer?.stats();
      if (!report || this.peer !== peer) return; // peer swapped mid-poll (reconnect) → drop this sample
      const { sample, fps, width, height, rttMs } = readStats([...report.values()] as RtcStat[]);
      const rate = this.prevSample ? rateStats(sample, this.prevSample) : { bitrateMbps: 0, lossPct: 0 };
      this.prevSample = sample;
      setText('stat-latency', `${rttMs} ms`);
      setText('stat-fps', `${fps} fps`);
      setText('stat-bitrate', `${rate.bitrateMbps} mbps`);
      setText('stat-res', width && height ? `${width}×${height}` : '—');
      setText('stat-loss', `${rate.lossPct}%`);
    } catch {
      // getStats can reject on a closing pc — ignore
    }
  }

  private endSession(): void {
    this.terminated = true; // keep the 'ended' UI; ignore the 'closed' status that sig.close() will fire
    this.setState('ended');
    this.peer?.close();
    this.peer = null;
    // Terminal: kick closes our socket server-side — mark the close intentional so the
    // signaling client doesn't treat it as a blip and auto-reconnect/re-join.
    this.sig.close();
  }

  private onStatus = (status: ConnectionStatus): void => {
    if (status === 'reconnecting') {
      this.wasReconnecting = true;
      this.setState('reconnecting');
    } else if (status === 'open' && this.wasReconnecting) {
      this.wasReconnecting = false;
      this.sig.join(this.code, this.pseudo, this.token); // re-enter → new 'joined' rebuilds the Peer
    } else if (status === 'closed' && !this.terminated) {
      setText('conn-label', 'disconnected');
      el('conn-dot').style.background = DOT.muted;
    }
  };

  private setState(state: ViewerState): void {
    const video = el<HTMLVideoElement>('viewer-video');
    // Leaving 'reconnecting' (recovered or terminal) cancels the give-up timer.
    if (state !== 'reconnecting' && this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // reset transient surfaces
    hide(el('viewer-reconnect-overlay'));
    hide(el('viewer-ended'));
    hide(el('viewer-error'));
    hide(el('viewer-paused'));
    hide(el('viewer-stats')); // stats overlay only makes sense over a live stream (re-shown below)
    hide(el('viewer-live-badge'));
    hide(el('viewer-reconnecting-badge'));

    this.setWatching(state === 'live'); // gate the UI auto-hide

    const dot = el('conn-dot');
    switch (state) {
      case 'connecting':
        hide(video);
        hide(el('viewer-controls'));
        video.srcObject = null; // drop any frozen frame from a previous session/attempt
        setText('conn-label', 'connecting…');
        dot.style.background = DOT.muted;
        break;
      case 'live':
        show(video);
        show(el('viewer-controls'));
        show(el('viewer-live-badge'));
        if (this.statsOn) show(el('viewer-stats'));
        setText('conn-label', 'connected');
        dot.style.background = DOT.good;
        break;
      case 'paused':
        hide(video);
        hide(el('viewer-controls'));
        show(el('viewer-paused'));
        setText('conn-label', 'paused');
        dot.style.background = DOT.gold;
        break;
      case 'reconnecting':
        show(el('viewer-reconnect-overlay'));
        show(el('viewer-reconnecting-badge'));
        setText('conn-label', 'reconnecting…');
        dot.style.background = DOT.gold;
        // Arm the give-up timer on the first reconnecting tick; keep the same deadline across
        // repeated ticks (don't reset it), so a flapping-but-dead link still fails over.
        if (this.reconnectTimer === null)
          this.reconnectTimer = setTimeout(() => this.setState('error'), RECONNECT_TIMEOUT_MS);
        break;
      case 'ended':
        hide(video);
        hide(el('viewer-controls'));
        show(el('viewer-ended'));
        setText('conn-label', 'ended');
        dot.style.background = DOT.muted;
        break;
      case 'error':
        hide(video);
        hide(el('viewer-controls'));
        show(el('viewer-error'));
        setText('conn-label', 'failed');
        dot.style.background = DOT.red;
        break;
    }
  }

  private wireControls(): void {
    const video = el<HTMLVideoElement>('viewer-video');
    const signal = this.ac.signal; // removes all these on destroy() — the viewer screen is reused
    // One delegated listener for the (recreated) tier buttons — no per-button listener leak.
    el('viewer-quality').addEventListener(
      'click',
      (e) => {
        const btn = (e.target as HTMLElement).closest('button');
        if (btn?.dataset.tier) this.selectTier(parseTier(btn.dataset.tier));
      },
      { signal },
    );
    el('btn-leave').addEventListener('click', this.leave, { signal });
    el('btn-viewer-back-home').addEventListener('click', this.leave, { signal });
    el('btn-error-back-home').addEventListener('click', this.leave, { signal });
    el('btn-retry').addEventListener(
      'click',
      () => {
        this.setState('connecting');
        this.sig.join(this.code, this.pseudo, this.token);
      },
      { signal },
    );
    el('btn-mute').addEventListener(
      'click',
      () => {
        video.muted = !video.muted;
        el('btn-mute').style.opacity = video.muted ? '0.4' : '1';
      },
      { signal },
    );
    el<HTMLInputElement>('vol-range').addEventListener(
      'input',
      (e) => {
        const v = Number((e.target as HTMLInputElement).value);
        video.volume = v / 100;
        video.muted = v === 0;
        setText('vol-label', `${v}%`);
      },
      { signal },
    );
    el('btn-stats').addEventListener('click', () => this.toggleStats(), { signal });
    el('btn-pip').addEventListener(
      'click',
      () => {
        if (document.pictureInPictureElement) void document.exitPictureInPicture();
        else void video.requestPictureInPicture().catch(() => {});
      },
      { signal },
    );
    el('btn-fs').addEventListener(
      'click',
      () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void el('screen-viewer').requestFullscreen().catch(() => {});
      },
      { signal },
    );
  }

  // Auto-hide the UI (top bar + controls) for an immersive view: fade out after UI_IDLE_MS of
  // mouse stillness or when the pointer leaves the stage; any move brings it back. Only while
  // watching a live stream — paused/ended/error screens always keep the UI.
  private wireAutoHide(): void {
    const stage = el('screen-viewer');
    const signal = this.ac.signal;
    stage.addEventListener('mousemove', this.pokeUi, { signal });
    stage.addEventListener('mouseleave', () => this.setUiVisible(false), { signal });
  }

  private pokeUi = (): void => {
    if (!this.watching) return;
    this.setUiVisible(true);
    if (this.uiHideTimer !== null) clearTimeout(this.uiHideTimer);
    this.uiHideTimer = setTimeout(() => this.setUiVisible(false), UI_IDLE_MS);
  };

  private setUiVisible(visible: boolean): void {
    const shown = visible || !this.watching; // never hide unless a stream is actually playing
    for (const id of ['viewer-topbar', 'viewer-controls']) {
      const node = el(id);
      node.style.opacity = shown ? '1' : '0';
      node.style.pointerEvents = shown ? '' : 'none';
    }
    el('screen-viewer').style.cursor = shown ? '' : 'none';
  }

  // Called from setState: arm the idle-hide when a stream goes live, disarm (and reveal) otherwise.
  private setWatching(watching: boolean): void {
    this.watching = watching;
    if (this.uiHideTimer !== null) {
      clearTimeout(this.uiHideTimer);
      this.uiHideTimer = null;
    }
    if (watching) this.pokeUi(); // show now + start the 3s countdown
    else this.setUiVisible(true);
  }

  private leave = (): void => {
    this.destroy();
    this.onLeave();
  };

  /** Tear down the peer and subscriptions without navigating. */
  destroy(): void {
    this.ac.abort(); // remove all DOM listeners
    this.wakeLock.release();
    this.stopStats();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.uiHideTimer !== null) clearTimeout(this.uiHideTimer);
    this.offMessage();
    this.offStatus();
    this.peer?.close();
    this.peer = null;
    const video = el<HTMLVideoElement>('viewer-video');
    video.srcObject = null;
    el('viewer-quality').replaceChildren(); // don't leave stale tier buttons for the next session
  }
}
