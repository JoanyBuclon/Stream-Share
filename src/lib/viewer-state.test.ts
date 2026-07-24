// The viewer session state machine — the transition invariants that used to be buried in a
// DOM-coupled setState, now testable in isolation. Each test drives a sequence of events through
// reduce() and checks the resulting ui / memory / timer command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, initialSession, type ViewerSession, type ViewerEvent } from './viewer-state.ts';

// Fold a sequence of events, returning the final session (ignoring timer/uiChanged).
function run(...events: ViewerEvent[]): ViewerSession {
  return events.reduce((s, e) => reduce(s, e).session, initialSession);
}

test('starts connecting, reaches live on connect', () => {
  assert.equal(initialSession.ui, 'connecting');
  assert.equal(run({ type: 'connected' }).ui, 'live');
});

test('a host pause is remembered across an ICE blip (stays paused, not live)', () => {
  // pause arrives, then the link drops and recovers: the recovery must land on paused, because the
  // host is still paused — the whole reason hostPaused is memory and not derived from ICE.
  const s = run({ type: 'connected' }, { type: 'pause', paused: true }, { type: 'disconnected' }, { type: 'connected' });
  assert.equal(s.ui, 'paused');
  assert.equal(s.hostPaused, true);
});

test('resume after a pause returns to live', () => {
  const s = run({ type: 'connected' }, { type: 'pause', paused: true }, { type: 'pause', paused: false });
  assert.equal(s.ui, 'live');
  assert.equal(s.hostPaused, false);
});

test('a joiner paused before connecting shows paused, then live on resume', () => {
  // The host relays pause to a late joiner BEFORE the offer (pause-join path), so pause lands while
  // still connecting; the viewer must show paused, then live once the host resumes.
  let s = run({ type: 'pause', paused: true });
  assert.equal(s.ui, 'paused');
  s = run({ type: 'pause', paused: true }, { type: 'connected' });
  assert.equal(s.ui, 'paused', 'connected while paused stays paused');
  s = run({ type: 'pause', paused: true }, { type: 'connected' }, { type: 'pause', paused: false });
  assert.equal(s.ui, 'live');
});

test('failed before ever connecting is a hard error; after connecting it is reconnecting', () => {
  assert.equal(run({ type: 'failed' }).ui, 'error', 'never connected → direct path impossible');
  assert.equal(run({ type: 'connected' }, { type: 'failed' }).ui, 'reconnecting', 'was connected → host will ICE-restart');
});

test('give-up turns a stuck reconnect into error', () => {
  const s = run({ type: 'connected' }, { type: 'disconnected' }, { type: 'give-up' });
  assert.equal(s.ui, 'error');
});

test('terminate is absorbing: no later event repaints the ended screen', () => {
  const ended = run({ type: 'connected' }, { type: 'terminate', reason: 'kicked' });
  assert.equal(ended.ui, 'ended');
  assert.equal(ended.endReason, 'kicked');
  // A late ICE transition or control after a kick must not move off 'ended' (the old code guarded
  // only ICE, so a stray control could slip through — the machine closes that gap).
  assert.equal(reduce(ended, { type: 'connected' }).session.ui, 'ended');
  assert.equal(reduce(ended, { type: 'disconnected' }).session.ui, 'ended');
  assert.equal(reduce(ended, { type: 'failed' }).session.ui, 'ended');
  assert.equal(reduce(ended, { type: 'pause', paused: false }).session.ui, 'ended');
});

test('the give-up timer arms once on entering reconnecting and is not reset by a flapping link', () => {
  // Enter reconnecting → arm. A second disconnected (already reconnecting) → no timer command, so
  // the adapter never restarts the deadline: a link that flaps still fails over on the first clock.
  const connected = reduce(initialSession, { type: 'connected' }).session;
  const first = reduce(connected, { type: 'disconnected' });
  assert.equal(first.timer, 'arm');
  assert.equal(first.session.ui, 'reconnecting');
  const second = reduce(first.session, { type: 'disconnected' });
  assert.equal(second.timer, null, 'already reconnecting → do not re-arm (deadline must not move)');
  assert.equal(second.uiChanged, false);
});

test('recovering from reconnecting cancels the give-up timer', () => {
  const reconnecting = reduce(reduce(initialSession, { type: 'connected' }).session, { type: 'disconnected' }).session;
  assert.equal(reduce(reconnecting, { type: 'connected' }).timer, 'cancel');
  assert.equal(reduce(reconnecting, { type: 'give-up' }).timer, 'cancel', 'give-up also leaves reconnecting');
});

test('uiChanged is false when the visible state does not move', () => {
  const live = reduce(initialSession, { type: 'connected' }).session;
  assert.equal(reduce(live, { type: 'connected' }).uiChanged, false, 'connected while already live');
});
