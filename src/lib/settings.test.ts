import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPreset, maxBitrateBps, estimatedUpload, contentHintFor, degradationFor, viewerTiers, effectiveScale, resLabel, sourceTier, parseQuality, serializeQuality, parseSdrStops, clampSdrStops, sdrWhiteFactor, SDR_STOPS_MAX, DEFAULT_QUALITY, PRESETS, RESOLUTIONS } from './settings.ts';

// parseQuality is a trust boundary: localStorage is user-editable, and — the real reason — it is
// read by a self-updating desktop app that may have written it under an older schema. Everything
// below is about degrading one field at a time instead of losing the lot.

test('parseQuality: a full valid payload round-trips', () => {
  const q = { ...DEFAULT_QUALITY, preset: null, resolution: 1080 as const, fps: 30, bitrate: 8, systemAudio: false };
  assert.deepEqual(parseQuality(serializeQuality(q)), { ...q, mic: false });
});

test('parseQuality: nothing stored yet is the default', () => {
  assert.deepEqual(parseQuality(null), DEFAULT_QUALITY);
});

test('parseQuality: the fallback is a COPY, never the shared default object', () => {
  const a = parseQuality(null);
  a.bitrate = 999;
  assert.equal(DEFAULT_QUALITY.bitrate, 20, 'mutating a parsed value must not poison the default');
});

test('parseQuality: garbage and wrong shapes fall back instead of throwing', () => {
  for (const raw of ['', 'not json', '[]', 'null', '42', '"a string"', '{']) {
    assert.deepEqual(parseQuality(raw), DEFAULT_QUALITY, `raw: ${raw}`);
  }
});

test('parseQuality: one bad field does not discard the good ones', () => {
  // The whole point of per-field validation: the day 120 leaves the fps ladder, an all-or-nothing
  // parse would also throw away a perfectly good bitrate and preset.
  const out = parseQuality(JSON.stringify({ preset: null, resolution: 1440, fps: 240, bitrate: 33 }));
  assert.equal(out.fps, DEFAULT_QUALITY.fps, 'the unknown fps falls back');
  assert.equal(out.resolution, 1440, 'and the rest survives');
  assert.equal(out.bitrate, 33);
  assert.equal(out.preset, null);
});

test('parseQuality: values outside the allowed sets are rejected', () => {
  const bad = {
    preset: 'ultra',
    resolution: 4320, // above the ladder
    fps: 0,
    bitrate: 500,
    systemAudio: 'yes', // not a boolean
  };
  assert.deepEqual(parseQuality(JSON.stringify(bad)), DEFAULT_QUALITY);
  assert.equal(parseQuality(JSON.stringify({ bitrate: 1 })).bitrate, DEFAULT_QUALITY.bitrate, 'under the slider min');
  assert.equal(parseQuality(JSON.stringify({ bitrate: 61 })).bitrate, DEFAULT_QUALITY.bitrate, 'over the slider max');
  assert.equal(parseQuality(JSON.stringify({ bitrate: 12.5 })).bitrate, DEFAULT_QUALITY.bitrate, 'not an integer');
  assert.equal(parseQuality(JSON.stringify({ resolution: '1080' })).resolution, DEFAULT_QUALITY.resolution, 'string');
});

test('parseQuality: every value the UI can actually produce is accepted', () => {
  // The mirror of the test above, and the half that is easy to forget: a range check with the
  // wrong comparison, or a tier missing from the ladder, rejects legitimate settings and silently
  // resets them. Only the inclusive ends and the rarely-clicked tiers would catch that.
  for (const bitrate of [2, 60]) {
    assert.equal(parseQuality(JSON.stringify({ bitrate })).bitrate, bitrate, `bitrate ${bitrate} is in range`);
  }
  for (const fps of [10, 30, 60, 120]) {
    assert.equal(parseQuality(JSON.stringify({ fps })).fps, fps, `fps ${fps} is on the ladder`);
  }
  for (const resolution of RESOLUTIONS) {
    assert.equal(parseQuality(JSON.stringify({ resolution })).resolution, resolution, `res ${resolution}`);
  }
  for (const preset of Object.keys(PRESETS)) {
    assert.equal(parseQuality(JSON.stringify({ preset })).preset, preset, `preset ${preset}`);
  }
});

test('parseQuality: an inherited Object key is not a preset', () => {
  // `'toString' in PRESETS` is true. Accepting it would put PRESETS['toString'].contentHint —
  // undefined — into the contentHint setter and degradationPreference, silently.
  assert.equal(parseQuality(JSON.stringify({ preset: 'toString' })).preset, DEFAULT_QUALITY.preset);
  assert.equal(parseQuality(JSON.stringify({ preset: 'constructor' })).preset, DEFAULT_QUALITY.preset);
});

test('parseQuality: a __proto__ payload cannot reach the prototype', () => {
  // Same reasoning as isQualityRequest in host.test.ts: JSON.parse makes "__proto__" an OWN data
  // property rather than invoking the setter, so the object keeps Object.prototype. Pinned as a
  // precedent — no hardening code needed for it.
  const out = parseQuality('{"__proto__":{"bitrate":999}}');
  assert.deepEqual(out, DEFAULT_QUALITY);
  assert.equal(({} as { bitrate?: number }).bitrate, undefined, 'Object.prototype is untouched');
});

test('parseQuality: the microphone is never restored, even when stored as true', () => {
  // The one setting with a privacy dimension. Restoring it would fire getUserMedia and light the
  // OS mic indicator on the first capture of a session where nobody asked for it.
  assert.equal(parseQuality(JSON.stringify({ ...DEFAULT_QUALITY, mic: true })).mic, false);
  assert.ok(!('mic' in JSON.parse(serializeQuality({ ...DEFAULT_QUALITY, mic: true }))), 'not even written');
});

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

// --- exposition du tone map HDR ---
//
// Ce réglage divise chaque pixel : une valeur non finie ou négative ne donne pas une image un peu
// fausse, elle donne des NaN sur tout l'écran. Et il est lu depuis localStorage, donc éditable à la
// main et écrit par une version antérieure de l'app.

test('sdrWhiteFactor: exponentiel, et « comme mesuré » pile au centre', () => {
  assert.equal(sdrWhiteFactor(0), 1, 'le défaut doit être neutre');
  assert.equal(sdrWhiteFactor(1), 2);
  assert.equal(sdrWhiteFactor(-1), 0.5);
  // Les bornes valent un huitième / huit fois la valeur rapportée. Dimensionnées sur le cas qui
  // motive le réglage : l'écran qui ne rapporte rien laisse le shell à 80 nits, soit 2,6 stops sous
  // les 480 mesurés ici — à ±2 cet utilisateur butait sur la fin de course avant d'atteindre le sien.
  assert.equal(sdrWhiteFactor(SDR_STOPS_MAX), 8);
  assert.equal(sdrWhiteFactor(-SDR_STOPS_MAX), 0.125);
  // Borné, pas ignoré : un curseur trafiqué ne doit pas noircir le partage.
  assert.equal(sdrWhiteFactor(99), 8);
});

test('clampSdrStops: tout ce qui n est pas un nombre fini retombe sur « comme mesuré »', () => {
  assert.equal(clampSdrStops(NaN), 0);
  assert.equal(clampSdrStops(Infinity), 0);
  assert.equal(clampSdrStops(-Infinity), 0);
  assert.equal(clampSdrStops(0.35), 0.35, 'le clamp ne crante pas — le pas de 0,05 est celui de l input, pas de la donnée');
});

test('parseSdrStops: rien de stocké = comme mesuré, et le stock est validé', () => {
  assert.equal(parseSdrStops(null), 0);
  assert.equal(parseSdrStops('1.5'), 1.5);
  assert.equal(parseSdrStops('12'), SDR_STOPS_MAX);
  assert.equal(parseSdrStops('pas un nombre'), 0);
  assert.equal(parseSdrStops(''), 0, 'Number("") vaut 0, ce qui tombe juste — mais par accident');
});
