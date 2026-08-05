// `canCaptureNative()` is the gate that decides whether a share takes the native HDR path at all,
// and the only part of native-video.ts that runs without a MessagePort, a VideoFrame or a
// MediaStreamTrackGenerator — so it is the only part testable here. Everything else lives in
// e2e/desktop-hdr.spec.ts (routing, above the port) and tools/native-track.cjs (the real addon).
//
// The case worth a test is not "is there a shell": it is a shell that is TOO OLD. The HDR methods
// shipped after the desktop app did, so an installer from before them paired with a newer web
// build has `startNativeCapture` and no `setCaptureFps` — which would capture in HDR while the fps
// slider silently did nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canCaptureNative } from './native-video.ts';

/** The four methods the native path needs, all present. */
const full = {
  canCaptureNative: () => true,
  startNativeCapture: () => {},
  setCaptureFps: () => {},
  nativeCaptureStats: () => null,
};

function withNative(native: unknown): void {
  (globalThis as unknown as { window: { native?: unknown } }).window = { native };
}

test('no shell at all means no native path', () => {
  withNative(undefined);
  assert.equal(canCaptureNative(), false);
});

test('a shell that says no is taken at its word', () => {
  withNative({ ...full, canCaptureNative: () => false });
  assert.equal(canCaptureNative(), false);
});

test('a complete shell that says yes gets the native path', () => {
  withNative(full);
  assert.equal(canCaptureNative(), true);
});

for (const missing of ['startNativeCapture', 'setCaptureFps', 'nativeCaptureStats'] as const) {
  test(`a shell missing ${missing} falls back rather than run half-driveable`, () => {
    const partial: Record<string, unknown> = { ...full };
    delete partial[missing];
    withNative(partial);
    assert.equal(canCaptureNative(), false);
  });
}
