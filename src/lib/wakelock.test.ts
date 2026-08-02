import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WakeLock, createWakeLock } from './wakelock.ts';

// createWakeLock picks between two things that are NOT interchangeable: a document-scoped sentinel
// that dies when the window hides, and the shell's process-level blocker that does not. Picking
// wrong on the desktop is silent — the display just sleeps mid-stream.

/** Install/remove a fake `window` for one test. `globalThis.window` is absent under node:test,
 *  which is also the branch the web build takes. */
function withWindow(native: { setWakeLock(on: boolean): void } | undefined, run: () => void): void {
  const g = globalThis as unknown as { window?: unknown };
  g.window = { native };
  try {
    run();
  } finally {
    delete g.window;
  }
}

test('createWakeLock uses the shell blocker when running inside it', () => {
  const calls: boolean[] = [];
  withWindow({ setWakeLock: (on) => calls.push(on) }, () => {
    const wl = createWakeLock();
    assert.ok(!(wl instanceof WakeLock), 'the sentinel machinery must not be in play at all');
    void wl.request();
    wl.release();
  });
  assert.deepEqual(calls, [true, false]);
});

test('createWakeLock falls back to the browser sentinel with no shell', () => {
  // Both the plain web build (no `window.native`) and a `window` that has no shell bridge.
  assert.ok(createWakeLock() instanceof WakeLock, 'no window at all');
  withWindow(undefined, () => assert.ok(createWakeLock() instanceof WakeLock, 'window without native'));
});

function fakeSentinel() {
  const s = {
    released: false,
    release: async () => {
      s.released = true;
    },
    addEventListener() {},
  };
  return s;
}
const asSentinel = (s: ReturnType<typeof fakeSentinel>) => s as unknown as WakeLockSentinel;

test('request() acquiert un lock; release() le relâche', async () => {
  const s = fakeSentinel();
  const wl = new WakeLock(async () => asSentinel(s));
  await wl.request();
  wl.release();
  assert.equal(s.released, true);
});

test('release() pendant une acquisition en vol relâche le lock résolu (pas de fuite)', async () => {
  const s = fakeSentinel();
  let grant!: (v: WakeLockSentinel) => void;
  const wl = new WakeLock(() => new Promise<WakeLockSentinel>((r) => (grant = r)));
  const p = wl.request(); // acquire bloqué sur la factory
  wl.release(); // teardown avant résolution
  grant(asSentinel(s)); // le lock est accordé en retard
  await p;
  assert.equal(s.released, true, 'le lock acquis après release est relâché, pas retenu');
});

test('un échec de la factory est avalé (best-effort), pas de crash', async () => {
  const wl = new WakeLock(async () => {
    throw new Error('NotAllowedError');
  });
  await wl.request(); // ne doit pas rejeter
  wl.release();
});
