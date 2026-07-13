import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStats, rateStats } from './stats.ts';

test('readStats: extrait inbound-rtp vidéo + RTT de la paire active', () => {
  const report = [
    { type: 'inbound-rtp', kind: 'audio', bytesReceived: 999 }, // ignoré (audio)
    { type: 'inbound-rtp', kind: 'video', bytesReceived: 1000, packetsReceived: 50, packetsLost: 2, framesPerSecond: 59.6, frameWidth: 1920, frameHeight: 1080, timestamp: 5000 },
    { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.024 },
  ];
  const r = readStats(report);
  assert.deepEqual(r.sample, { bytes: 1000, packets: 50, lost: 2, ts: 5000 });
  assert.equal(r.fps, 60); // arrondi
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
  assert.equal(r.rttMs, 24);
});

test('readStats: valeurs par défaut si le rapport est incomplet', () => {
  const r = readStats([]);
  assert.deepEqual(r.sample, { bytes: 0, packets: 0, lost: 0, ts: 0 });
  assert.equal(r.fps, 0);
  assert.equal(r.rttMs, 0);
});

test('rateStats: bitrate (mbps) et perte (%) depuis le delta', () => {
  const prev = { bytes: 1_000_000, packets: 100, lost: 0, ts: 1000 };
  const cur = { bytes: 2_250_000, packets: 190, lost: 10, ts: 2000 }; // +1.25 Mo en 1 s
  const { bitrateMbps, lossPct } = rateStats(cur, prev);
  assert.equal(bitrateMbps, 10); // 1.25e6 octets * 8 / 1 s / 1e6 = 10 mbps
  assert.equal(lossPct, 10); // 10 perdus / (90 reçus + 10 perdus) = 10 %
});

test('rateStats: dt nul ou pas de paquets → 0 (pas de NaN/Infinity)', () => {
  const s = { bytes: 100, packets: 10, lost: 0, ts: 1000 };
  assert.deepEqual(rateStats(s, s), { bitrateMbps: 0, lossPct: 0 });
});
