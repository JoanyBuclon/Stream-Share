// Viewer controller: a single Peer to the host, stream playback, lifecycle states,
// quality tier requests and a local stats overlay. On a signaling blip it re-joins
// (new peerId + Peer). See docs/frontend.md.

import { Signaling, type ServerMessage, type ConnectionStatus } from './signaling.ts';
import { Peer, type PeerSignal } from './peer.ts';
import { el, show, hide, setText } from './dom.ts';
import { formatCode } from './code.ts';
import { viewerTiers, type ViewerTier } from './settings.ts';
import { readStats, rateStats, type RtcStat, type Sample } from './stats.ts';
import { WakeLock } from './wakelock.ts';
import {
  reduce,
  initialSession,
  type ViewerSession,
  type ViewerEvent,
  type ViewerUiState,
  type EndReason,
} from './viewer-state.ts';

export interface ViewerInit {
  hostId: string;
  iceServers: RTCIceServer[];
}

// Connection-dot colors reference the @theme tokens (single source of truth, cf. app.css).
const DOT = { good: 'var(--color-good)', gold: 'var(--color-gold)', muted: 'var(--color-muted-4)', red: 'var(--color-live)' };

// Host pause/resume travels over the signal relay (opaque `data`), distinct from SDP/ICE.
type PeerControl = { control: 'pause' | 'resume' };
export function isControl(data: unknown): data is PeerControl {
  if (typeof data !== 'object' || data === null || !('control' in data)) return false;
  // The value matters as much as the key: `onControl` does `hostPaused = control === 'pause'`,
  // so any unknown value counts as a resume. Without this check, `{control:'x'}` pulls the viewer
  // out of a host pause — and a future host-side verb would do so silently too.
  const control = (data as { control: unknown }).control;
  return control === 'pause' || control === 'resume';
}

// The host announces its cap height (tier ceiling) over the same relay. Validate the value.
export function isHeight(data: unknown): data is { height: number } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'height' in data &&
    typeof (data as { height: unknown }).height === 'number' &&
    (data as { height: number }).height > 0
  );
}

// The three terminal exits share the `#viewer-ended` screen, but not the message: the markup's
// default text is the 'host-left' one. (EndReason comes from the viewer-state domain.)
const END_TEXT: Record<EndReason, { title: string; body: string }> = {
  'host-left': {
    title: 'The host stopped sharing',
    body: 'The session has ended. Thanks for watching — you can join another room whenever you like.',
  },
  kicked: {
    title: 'You were removed from this room',
    body: 'The host ended your access to this share. You can join another room, or this one again if the host lets you back in.',
  },
  banned: {
    title: 'You were banned from this room',
    body: 'The host blocked your access to this share. Joining it again with the same code will be refused.',
  },
};

function tierLabel(tier: ViewerTier): string {
  return tier === 'auto' ? 'Auto' : tier === 'source' ? 'Source' : `${tier}p`;
}

export function parseTier(v: string): ViewerTier {
  return v === 'auto' ? 'auto' : v === 'source' ? 'source' : (Number(v) as 1440 | 1080 | 720 | 480);
}

// If the transport never recovers, stop spinning on "reconnecting" and surface the failure.
// Generous enough to cover the host's capped ICE restarts (a real blip recovers in seconds).
const RECONNECT_TIMEOUT_MS = 20_000;

// Immersive playback: fade the top bar + controls after the mouse sits still this long.
const UI_IDLE_MS = 3_000;

/** Did this event land on the viewer chrome (rather than the video stage behind it)? */
function onViewerUi(e: Event): boolean {
  return (e.target as HTMLElement).closest('#viewer-topbar, #viewer-controls') !== null;
}

export class ViewerController {
  private readonly sig: Signaling;
  private readonly code: string;
  private readonly pseudo: string;
  private readonly token: string;
  private readonly onLeave: () => void;
  private config: RTCConfiguration;
  private hostId: string;
  private peer: Peer | null = null;
  private session: ViewerSession = initialSession; // UI state machine (transitions live in viewer-state.ts)
  private wasReconnecting = false;
  private tier: ViewerTier = 'auto'; // requested quality; re-sent on (re)connect so the host stays in sync
  private hostHeight = 0; // host cap height (tier ceiling), announced by the host — NOT inferred from the ramping received video
  private statsOn = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private prevSample: Sample | null = null; // previous getStats sample (for bitrate/loss deltas)
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private uiHideTimer: ReturnType<typeof setTimeout> | null = null;
  private watching = false; // true only while a live stream plays → gate the UI auto-hide
  private uiVisible = true; // mirrors setUiVisible → lets a touch tap toggle rather than only reveal
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

    this.render(); // paint the initial 'connecting' state (session starts there)
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
        if (this.tier !== 'auto') this.sig.signal(this.hostId, { quality: this.tier }); // resync after (re)connect
        this.dispatch({ type: 'connected' });
        this.playVideo(); // media is ready now — the reliable moment to (re)start playback
      },
      onIceState: (state) => this.onIceState(state),
    });
  }

  // ICE transitions map straight to domain events; the machine owns the terminated guard, the
  // everConnected → error-vs-reconnecting decision, and the give-up timer.
  private onIceState(state: RTCIceConnectionState): void {
    if (state === 'connected' || state === 'completed') this.dispatch({ type: 'connected' });
    else if (state === 'disconnected') this.dispatch({ type: 'disconnected' });
    else if (state === 'failed') this.dispatch({ type: 'failed' });
  }

  private onMessage = (msg: ServerMessage): void => {
    switch (msg.type) {
      case 'signal': {
        if (msg.from !== this.hostId) break;
        if (isControl(msg.data)) this.onControl(msg.data.control);
        else if (isHeight(msg.data)) {
          this.hostHeight = msg.data.height; // host announced its cap → tier ceiling
          this.renderTiers();
        } else this.peer?.accept(msg.data as PeerSignal).catch(() => {}); // bad SDP → local, not an unhandled rejection
        break;
      }
      case 'joined': // fresh join after a reconnect
        this.config = { iceServers: msg.iceServers };
        this.buildPeer(msg.hostId);
        break;
      case 'peer-left': // viewers only ever get the host's departure (room destroyed)
        if (msg.peerId === this.hostId) this.endSession('host-left');
        break;
      case 'kicked':
        this.endSession(msg.banned ? 'banned' : 'kicked');
        break;
    }
  };

  private onControl(control: 'pause' | 'resume'): void {
    this.dispatch({ type: 'pause', paused: control === 'pause' });
  }

  // The <video> is unmuted (audio is the product), so autoplay policies block playback unless a
  // recent user gesture is in scope — and the join click has expired by the time ICE completes.
  // A silent .play() failure leaves a black, muted stream under a "connected" UI, so surface it:
  // the prompt's own click is a fresh gesture that lets the retry succeed.
  private playVideo(): void {
    const video = el<HTMLVideoElement>('viewer-video');
    void video
      .play()
      .then(() => hide(el('viewer-play-prompt')))
      .catch(() => show(el('viewer-play-prompt')));
  }

  // Rebuild the quality-tier buttons from the host's announced cap height (called on the `height`
  // relay and on a tier pick). Tiers above the host stream never appear.
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
      const active = tier === this.tier;
      btn.dataset.active = String(active);
      btn.setAttribute('aria-pressed', String(active)); // data-active is visual-only for a screen reader
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
    el('btn-stats').setAttribute('aria-pressed', String(this.statsOn));
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
    // render() hides #viewer-stats on paused/reconnecting/ended/error but leaves the timer
    // running: without this guard we pay a getStats() + 5 setText per second on an overlay
    // nobody sees. stopStats() is only reached via toggleStats / destroy.
    if (!this.watching) return;
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

  // A PiP window is a separate always-on-top surface: it outlives the stream and keeps showing a
  // dead frame long after the session is over, with no control to close it (our button lives on a
  // screen the user is no longer looking at). Fullscreen doesn't need this — it stays on our own
  // document, where the terminal panel is readable and Esc gets out.
  // Not called on 'paused': that one is transient and resuming must find the window still there.
  private closePip(): void {
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
  }

  private endSession(reason: EndReason): void {
    // The same screen serves all three exits. Without this text, a kicked or banned viewer read
    // "The host stopped sharing" — then "you have been banned" if they re-entered the code, two
    // contradictory messages, neither describing what had just happened. Set the text before the
    // dispatch that renders the 'ended' screen. The domain marks the session terminated (absorbing).
    setText('viewer-ended-title', END_TEXT[reason].title);
    setText('viewer-ended-body', END_TEXT[reason].body);
    this.dispatch({ type: 'terminate', reason });
    this.peer?.close();
    this.peer = null;
    // Terminal: kick closes our socket server-side — mark the close intentional so the
    // signaling client doesn't treat it as a blip and auto-reconnect/re-join.
    this.sig.close();
  }

  private onStatus = (status: ConnectionStatus): void => {
    if (status === 'reconnecting') {
      this.wasReconnecting = true;
      this.dispatch({ type: 'disconnected' }); // signaling blip → same 'reconnecting' UI as an ICE blip
    } else if (status === 'open' && this.wasReconnecting) {
      this.wasReconnecting = false;
      this.sig.join(this.code, this.pseudo, this.token); // re-enter → new 'joined' rebuilds the Peer
    } else if (status === 'closed' && !this.session.terminated) {
      setText('conn-label', 'disconnected');
      el('conn-dot').style.background = DOT.muted;
    }
  };

  // Feed an event to the state machine, apply the timer command it returns, and repaint only if the
  // visible state moved. The reconnect give-up timer lives here (not in render): the domain says
  // 'arm' exactly on entering reconnecting and 'cancel' on leaving, so a flapping link never resets
  // the deadline. The timeout dispatches 'give-up', which the machine turns into 'error'.
  private dispatch(event: ViewerEvent): void {
    const { session, uiChanged, timer } = reduce(this.session, event);
    this.session = session;
    if (timer === 'arm' && this.reconnectTimer === null) {
      this.reconnectTimer = setTimeout(() => this.dispatch({ type: 'give-up' }), RECONNECT_TIMEOUT_MS);
    } else if (timer === 'cancel' && this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (uiChanged) this.render();
  }

  private render(): void {
    const state: ViewerUiState = this.session.ui;
    const video = el<HTMLVideoElement>('viewer-video');
    // reset transient surfaces
    hide(el('viewer-reconnect-overlay'));
    hide(el('viewer-ended'));
    hide(el('viewer-error'));
    hide(el('viewer-paused'));
    hide(el('viewer-stats')); // stats overlay only makes sense over a live stream (re-shown below)
    hide(el('viewer-live-badge'));
    hide(el('viewer-reconnecting-badge'));
    hide(el('viewer-play-prompt')); // only 'live' re-arms it, via playVideo()

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
        this.playVideo(); // shows the play prompt if the browser blocks autoplay
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
        break;
      case 'ended':
        hide(video);
        hide(el('viewer-controls'));
        this.closePip();
        show(el('viewer-ended'));
        setText('conn-label', 'ended');
        dot.style.background = DOT.muted;
        break;
      case 'error':
        hide(video);
        hide(el('viewer-controls'));
        this.closePip();
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
        this.dispatch({ type: 'connecting' });
        this.sig.join(this.code, this.pseudo, this.token);
      },
      { signal },
    );
    el('btn-mute').addEventListener(
      'click',
      () => {
        video.muted = !video.muted;
        el('btn-mute').style.opacity = video.muted ? '0.4' : '1';
        el('btn-mute').setAttribute('aria-pressed', String(video.muted));
      },
      { signal },
    );
    // The prompt's click is the user gesture that unblocks playback (see playVideo).
    el('viewer-play-prompt').addEventListener('click', () => this.playVideo(), { signal });
    el<HTMLInputElement>('vol-range').addEventListener(
      'input',
      (e) => {
        const input = e.target as HTMLInputElement;
        const v = Number(input.value);
        video.volume = v / 100;
        video.muted = v === 0;
        setText('vol-label', `${v}%`);
        input.setAttribute('aria-valuetext', `${v}%`); // otherwise read as "50 of 100", unitless
      },
      { signal },
    );
    el('btn-stats').addEventListener('click', () => this.toggleStats(), { signal });
    // iOS Safari ships neither API on the element: calling them throws a *synchronous* TypeError
    // that the .catch() below could never see. Hide the buttons rather than offer a dead control.
    if (document.pictureInPictureEnabled) {
      el('btn-pip').addEventListener(
        'click',
        () => {
          if (document.pictureInPictureElement) void document.exitPictureInPicture();
          else void video.requestPictureInPicture().catch(() => {});
        },
        { signal },
      );
    } else hide(el('btn-pip'));
    if (document.fullscreenEnabled) {
      el('btn-fs').addEventListener(
        'click',
        () => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void el('screen-viewer').requestFullscreen().catch(() => {});
        },
        { signal },
      );
    } else hide(el('btn-fs'));
  }

  // Auto-hide the UI (top bar + controls) for an immersive view. Only while watching a live
  // stream — paused/ended/error screens always keep the UI (pokeUi is `watching`-gated).
  //
  // Mouse: fade out after UI_IDLE_MS of stillness or when the pointer leaves the stage; any move
  // brings it back. Touch: there is no "still" and no leave, so tap the stage to toggle.
  private wireAutoHide(): void {
    const stage = el('screen-viewer');
    const signal = this.ac.signal;
    // pointermove filtered on pointerType, not mousemove: a tap also fires a compatibility
    // mousemove, which would re-show the UI the same tap just dismissed. Compat mouse events have
    // no pointer counterpart, so the filter is exact. For a real mouse, pointermove === mousemove.
    stage.addEventListener('pointermove', this.onPointerMove, { signal });
    stage.addEventListener('mouseleave', () => this.setUiVisible(false), { signal }); // not pointerleave: that fires on every touchend
    stage.addEventListener('pointerup', this.onTouchTap, { signal });
  }

  private onPointerMove = (e: PointerEvent): void => {
    // Mouse: any move revives the UI. Touch: only a drag *on the controls* does — it keeps the bar
    // alive through a slow volume drag, which emits no mousemove and used to fade mid-gesture.
    if (e.pointerType === 'mouse' || onViewerUi(e)) this.pokeUi();
  };

  // Touch has no "pointer at rest" and no leave, so a tap on the stage toggles instead. On pointerup,
  // never pointerdown: the up would otherwise re-reveal what the down just dismissed.
  private onTouchTap = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return; // the mouse is served by pointermove/mouseleave above
    if (onViewerUi(e)) this.pokeUi(); // touching a control keeps it up / ends a drag → re-arm
    else if (this.uiVisible) this.setUiVisible(false); // tap the video → dismiss
    else this.pokeUi(); // tap it again → bring the UI back
  };

  private pokeUi = (): void => {
    if (!this.watching) return;
    this.setUiVisible(true);
    if (this.uiHideTimer !== null) clearTimeout(this.uiHideTimer);
    this.uiHideTimer = setTimeout(() => this.setUiVisible(false), UI_IDLE_MS);
  };

  private setUiVisible(visible: boolean): void {
    const shown = visible || !this.watching; // never hide unless a stream is actually playing
    // Called on every pointermove (60-144/s), but only the first move after a hide changes
    // anything. `uiVisible` is mutated only here and always reflects the last state written
    // to the DOM → the guard is safe. Re-arming the auto-hide timer lives in pokeUi, so OUTSIDE
    // this guard: the auto-hide semantics depend on that.
    if (shown === this.uiVisible) return;
    this.uiVisible = shown;
    for (const id of ['viewer-topbar', 'viewer-controls']) {
      const node = el(id);
      node.style.opacity = shown ? '1' : '0';
      node.style.pointerEvents = shown ? '' : 'none';
    }
    el('screen-viewer').style.cursor = shown ? '' : 'none';
  }

  // Called from render(): arm the idle-hide when a stream goes live, disarm (and reveal) otherwise.
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
    this.closePip(); // covers the paths that never reach the 'ended' render: leave, hash change, teardown
    const video = el<HTMLVideoElement>('viewer-video');
    video.srcObject = null;
    el('viewer-quality').replaceChildren(); // don't leave stale tier buttons for the next session
    // Same reason, and it keeps the guard in setUiVisible self-contained: the next session gets
    // a fresh instance (uiVisible = true) but THIS DOM. Today every exit from 'live' passes
    // through setWatching(false) → setUiVisible(true), so the DOM is already restored and this
    // is a no-op — the guard's precondition holds only by that non-local argument. One line to
    // make it hold locally instead, because the failure it prevents (opacity:0 + the guard
    // agreeing there is nothing to write → controls dead until a reload) is unrecoverable.
    this.setUiVisible(true);
  }
}
