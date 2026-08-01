// The scheduling clamp is the whole of the native-audio logic: the WASAPI capture clock and the
// AudioContext clock are independent, and the addon drops silent buffers rather than sending them.
// Get this wrong and the shared sound either lags further behind the picture every minute, or
// stops after the first quiet moment. decodePcm is the trust boundary for bytes off an IPC pipe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStartTime, advance, decodePcm, LEAD_SECONDS, MAX_LEAD_SECONDS } from './native-audio.ts';

test('the first chunk is anchored one lead ahead of the clock', () => {
  assert.equal(nextStartTime(0, 10), 10 + LEAD_SECONDS);
});

test('a chunk arriving on time plays back to back with the previous one', () => {
  const cursor = 10 + LEAD_SECONDS + 0.02;
  assert.equal(nextStartTime(cursor, 10), cursor);
});

test('a gap re-anchors instead of scheduling in the past', () => {
  // The addon sends nothing during silence, so the cursor is left behind. Without the re-anchor
  // every queued chunk would be scheduled before currentTime and play all at once.
  assert.equal(nextStartTime(3, 10), 10 + LEAD_SECONDS);
  assert.equal(nextStartTime(10, 10), 10 + LEAD_SECONDS, 'exactly at now is still behind the lead');
});

test('running too far ahead resyncs instead of staying that far behind forever', () => {
  // Dropping the chunk and leaving the cursor put would pin the audio a full MAX_LEAD behind the
  // picture for the rest of the session. Re-anchoring costs one 10 ms glitch.
  assert.equal(nextStartTime(10 + MAX_LEAD_SECONDS + 0.01, 10), 10 + LEAD_SECONDS);
  const under = 10 + MAX_LEAD_SECONDS - 0.01;
  assert.equal(nextStartTime(under, 10), under, 'just under the ceiling still plays back to back');
});

test('the lead sits under the drop ceiling (else every chunk would be dropped)', () => {
  assert.ok(LEAD_SECONDS < MAX_LEAD_SECONDS);
});

test('two sources keep independent cursors', () => {
  // Muting 2+ apps runs one WASAPI session per app still audible, all arriving interleaved on one
  // IPC channel. On a shared cursor, A's chunk would push B's schedule forward, so every second
  // chunk would land in the past and be re-anchored — a permanent stutter on both streams.
  const cursors = new Map<string, number>();
  const chunk = 0.01;
  assert.equal(advance(cursors, 'Spotify', 10, chunk), 10 + LEAD_SECONDS);
  assert.equal(advance(cursors, 'chrome', 10, chunk), 10 + LEAD_SECONDS, 'the other source starts fresh, not queued');
  // Each one now continues from its OWN position rather than from the last chunk seen.
  assert.equal(advance(cursors, 'Spotify', 10, chunk), 10 + LEAD_SECONDS + chunk);
  assert.equal(advance(cursors, 'chrome', 10, chunk), 10 + LEAD_SECONDS + chunk);
});

test('a source that went quiet re-anchors instead of being pruned', () => {
  // Stale keys are deliberately never cleaned up: the cursor of an app that stopped is simply in
  // the past, which is the gap case. It must not schedule a burst when the app comes back.
  const cursors = new Map([['Spotify', 3]]);
  assert.equal(advance(cursors, 'Spotify', 10, 0.01), 10 + LEAD_SECONDS);
});

test('decodePcm de-interleaves stereo Int16 into per-channel Float32', () => {
  // Frames: (0, 32767), (-32768, 16384) — left and right must not be swapped or summed.
  const pcm = new Int16Array([0, 32767, -32768, 16384]);
  const [left, right] = decodePcm(new Uint8Array(pcm.buffer));
  assert.equal(left.length, 2);
  assert.equal(right.length, 2);
  assert.equal(left[0], 0);
  assert.ok(Math.abs(right[0] - 32767 / 32768) < 1e-6);
  assert.equal(left[1], -1, 'the most negative sample maps to exactly -1');
  assert.equal(right[1], 0.5);
});

test('decodePcm tolerates a truncated frame instead of reading past the buffer', () => {
  // Three samples = one full frame plus a stray one. The odd sample is dropped, not decoded
  // against uninitialised memory.
  const [left, right] = decodePcm(new Uint8Array(new Int16Array([100, 200, 300]).buffer));
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);
});

test('decodePcm respects the byteOffset of a view into a larger buffer', () => {
  // IPC hands over a Uint8Array that can be a window onto a pooled ArrayBuffer; ignoring
  // byteOffset would decode a neighbour's bytes as audio.
  const backing = new Int16Array([999, 999, 0, 32767]);
  const view = new Uint8Array(backing.buffer, 4, 4); // skip the first frame
  const [left, right] = decodePcm(view);
  assert.equal(left[0], 0);
  assert.ok(Math.abs(right[0] - 32767 / 32768) < 1e-6);
});
