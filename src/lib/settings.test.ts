import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPreset, maxBitrateBps, estimatedUpload, contentHintFor, degradationFor, viewerTiers, effectiveScale, resLabel, sourceTier, DEFAULT_QUALITY, PRESETS } from './settings.ts';

test('applyPreset: pose resolution/fps/bitrate + preset, garde l audio', () => {
  const q = { ...DEFAULT_QUALITY, mic: true, preset: null };
  const out = applyPreset(q, 'office');
  assert.equal(out.preset, 'office');
  assert.equal(out.resolution, PRESETS.office.resolution);
  assert.equal(out.fps, PRESETS.office.fps);
  assert.equal(out.bitrate, PRESETS.office.bitrate);
  assert.equal(out.mic, true, 'audio inchangé');
});

test('maxBitrateBps: mbps → bps', () => {
  assert.equal(maxBitrateBps(20), 20_000_000);
  assert.equal(maxBitrateBps(4.5), 4_500_000);
});

test('estimatedUpload: (bitrate + audio) × viewers (coût mesh)', () => {
  assert.equal(estimatedUpload({ ...DEFAULT_QUALITY, bitrate: 10, systemAudio: false, mic: false }, 1), 10);
  assert.equal(estimatedUpload({ ...DEFAULT_QUALITY, bitrate: 10, systemAudio: true, mic: true }, 1), 10.1);
  // Une seule piste Opus mixée : le micro seul coûte autant que système + micro (pas d'addition).
  assert.equal(estimatedUpload({ ...DEFAULT_QUALITY, bitrate: 10, systemAudio: true, mic: false }, 1), 10.1);
  assert.equal(estimatedUpload({ ...DEFAULT_QUALITY, bitrate: 10, systemAudio: false, mic: true }, 1), 10.1);
  assert.equal(estimatedUpload({ ...DEFAULT_QUALITY, bitrate: 10, systemAudio: false, mic: false }, 3), 30);
  assert.equal(estimatedUpload({ ...DEFAULT_QUALITY, bitrate: 10, systemAudio: false, mic: false }, 0), 10, 'au moins 1 pour l affichage');
});

test('viewerTiers: paliers sous la hauteur host, floor 480, + auto/source', () => {
  assert.deepEqual(viewerTiers(2160), ['auto', 'source', 1440, 1080, 720, 480]);
  assert.deepEqual(viewerTiers(1080), ['auto', 'source', 720, 480]);
  assert.deepEqual(viewerTiers(720), ['auto', 'source', 480]);
  assert.deepEqual(viewerTiers(480), ['auto', 'source'], 'palier host = Source, rien en dessous du floor');
  assert.deepEqual(viewerTiers(0), ['auto', 'source']);
});

test('effectiveScale: min(cap host, palier viewer), le plus agressif gagne, jamais d upscale', () => {
  assert.equal(effectiveScale(2160, 2160, 'auto'), 1); // cap 4K sur source 4K → natif
  assert.equal(effectiveScale(2160, 2160, 1080), 2); // 2160 → 1080
  assert.equal(effectiveScale(2160, 1080, 'source'), 2); // cap host 1080
  assert.equal(effectiveScale(2160, 1080, 720), 3); // host 1080 + viewer 720 → 720
  assert.equal(effectiveScale(1440, 2160, 480), 3); // 1440 → 480
  assert.equal(effectiveScale(1080, 2160, 1440), 1); // cap 4K sur source 1080 → natif (pas d upscale)
  assert.equal(effectiveScale(0, 2160, 720), 1); // hauteur inconnue
});

test('resLabel: 4K / 2K pour le haut, sinon Np', () => {
  assert.equal(resLabel(2160), '4K');
  assert.equal(resLabel(1440), '2K');
  assert.equal(resLabel(1080), '1080p');
  assert.equal(resLabel(480), '480p');
});

test('sourceTier: plus haut palier que la source peut remplir en natif, floor 480', () => {
  assert.equal(sourceTier(2160), 2160);
  assert.equal(sourceTier(1440), 1440);
  assert.equal(sourceTier(1200), 1080); // ultrawide → palier standard en dessous
  assert.equal(sourceTier(900), 720);
  assert.equal(sourceTier(400), 480);
  assert.equal(sourceTier(0), 480);
});

test('contentHint / degradation dérivent du preset, défauts en mode manuel', () => {
  assert.equal(contentHintFor({ ...DEFAULT_QUALITY, preset: 'office' }), 'detail');
  assert.equal(degradationFor({ ...DEFAULT_QUALITY, preset: 'gaming' }), 'maintain-framerate');
  assert.equal(contentHintFor({ ...DEFAULT_QUALITY, preset: null }), 'motion');
  assert.equal(degradationFor({ ...DEFAULT_QUALITY, preset: null }), 'balanced');
});
