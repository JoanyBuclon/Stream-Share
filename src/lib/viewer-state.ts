// Viewer session state machine — pure domain, no DOM and no WebRTC. viewer.ts feeds it events and
// renders the result; every transition rule that used to be tangled inside setState / onIceState /
// onControl lives here, so it can be reasoned about and unit-tested in isolation.
//
// The rules it owns:
//  - `ended` is absorbing: once kicked / banned / host-left, no late ICE or control event repaints
//    over the terminal screen (the old code guarded only ICE, so a stray control could slip through).
//  - a host pause is remembered: an ICE (re)connect while paused resolves to `paused`, not `live`.
//  - `failed` becomes `error` only if we never connected (direct path impossible — symmetric NAT, no
//    TURN); if we had connected, the host will ICE-restart, so we stay optimistic on `reconnecting`.
//  - the reconnect give-up timer is armed once on *entering* reconnecting and cancelled on leaving,
//    so a link that flaps (repeated `disconnected`) never pushes the deadline back.

export type ViewerUiState = 'connecting' | 'live' | 'reconnecting' | 'paused' | 'ended' | 'error';
export type EndReason = 'host-left' | 'kicked' | 'banned';

export type ViewerEvent =
  | { type: 'connecting' } // initial mount, or a manual retry from `error`
  | { type: 'connected' } // ICE connected/completed, or first media arrived (onTrack)
  | { type: 'disconnected' } // ICE disconnected, or the signaling socket is reconnecting
  | { type: 'failed' } // ICE failed
  | { type: 'pause'; paused: boolean } // host pause/resume, relayed over `signal`
  | { type: 'give-up' } // the reconnect deadline elapsed
  | { type: 'terminate'; reason: EndReason }; // host-left / kicked / banned

export interface ViewerSession {
  readonly ui: ViewerUiState;
  readonly everConnected: boolean;
  readonly hostPaused: boolean;
  readonly terminated: boolean;
  readonly endReason: EndReason | null;
}

export const initialSession: ViewerSession = {
  ui: 'connecting',
  everConnected: false,
  hostPaused: false,
  terminated: false,
  endReason: null,
};

// The timer command the adapter must apply. 'arm' fires only on entering reconnecting, 'cancel' on
// any exit — so the adapter never has to reason about idempotency, it just obeys.
export type TimerCommand = 'arm' | 'cancel' | null;

export interface Transition {
  readonly session: ViewerSession;
  readonly uiChanged: boolean; // the adapter re-renders the DOM only when the visible state moved
  readonly timer: TimerCommand;
}

/** With a stream up (connected or resumed), a remembered host pause decides paused vs live. */
function whenStreaming(hostPaused: boolean): ViewerUiState {
  return hostPaused ? 'paused' : 'live';
}

function next(s: ViewerSession, e: ViewerEvent): ViewerSession {
  if (s.terminated) return s; // absorbing: nothing moves off the terminal screen
  switch (e.type) {
    case 'connecting':
      return { ...s, ui: 'connecting' };
    case 'connected':
      return { ...s, everConnected: true, ui: whenStreaming(s.hostPaused) };
    case 'disconnected':
      return { ...s, ui: 'reconnecting' };
    case 'failed':
      return { ...s, ui: s.everConnected ? 'reconnecting' : 'error' };
    case 'pause':
      return { ...s, hostPaused: e.paused, ui: whenStreaming(e.paused) };
    case 'give-up':
      return { ...s, ui: 'error' };
    case 'terminate':
      return { ...s, terminated: true, endReason: e.reason, ui: 'ended' };
  }
}

export function reduce(s: ViewerSession, e: ViewerEvent): Transition {
  const session = next(s, e);
  const entered = session.ui === 'reconnecting' && s.ui !== 'reconnecting';
  const left = s.ui === 'reconnecting' && session.ui !== 'reconnecting';
  return {
    session,
    uiChanged: session.ui !== s.ui,
    timer: entered ? 'arm' : left ? 'cancel' : null,
  };
}
