import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WakeLock } from './wakelock.ts';

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
