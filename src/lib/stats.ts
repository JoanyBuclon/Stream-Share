// Pure parsing of RTCPeerConnection.getStats() into the viewer's display metrics. DOM/WebRTC-free
// so it's unit-testable — the polling + rendering live in viewer.ts.

// The subset of RTCStats fields we read (getStats() returns a heterogeneous report).
export interface RtcStat {
  type: string;
  id?: string;
  kind?: string;
  bytesReceived?: number;
  packetsReceived?: number;
  packetsLost?: number;
  framesPerSecond?: number;
  frameWidth?: number;
  frameHeight?: number;
  timestamp?: number;
  nominated?: boolean;
  state?: string;
  currentRoundTripTime?: number;
  codecId?: string;
  mimeType?: string;
}

// A cumulative sample; bitrate and loss are computed from the delta between two of these.
export interface Sample {
  bytes: number;
  packets: number;
  lost: number;
  ts: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Pull the video inbound-rtp counters + the active candidate-pair RTT from a stats report. */
export function readStats(report: RtcStat[]): {
  sample: Sample;
  fps: number;
  width: number;
  height: number;
  rttMs: number;
  codec: string;
} {
  const rtp = report.find((s) => s.type === 'inbound-rtp' && s.kind === 'video');
  const pair = report.find((s) => s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded'));
  // The codec is a SEPARATE stat the rtp entry points at. Guarded on codecId being present, or the
  // `undefined === undefined` match would pick whichever codec stat comes first — including the
  // audio one. Worth showing since viewers no longer all get the same codec: negotiation is
  // per-viewer now, so this is the only place the actual answer is visible (docs/webrtc-media.md).
  const codec = rtp?.codecId ? report.find((s) => s.type === 'codec' && s.id === rtp.codecId) : undefined;
  return {
    sample: {
      bytes: rtp?.bytesReceived ?? 0,
      packets: rtp?.packetsReceived ?? 0,
      lost: rtp?.packetsLost ?? 0,
      ts: rtp?.timestamp ?? 0,
    },
    fps: Math.round(rtp?.framesPerSecond ?? 0),
    width: rtp?.frameWidth ?? 0,
    height: rtp?.frameHeight ?? 0,
    rttMs: Math.round((pair?.currentRoundTripTime ?? 0) * 1000),
    // "video/H265" → "H265". Empty when unknown; the caller decides what to show instead.
    codec: codec?.mimeType?.replace(/^video\//, '') ?? '',
  };
}

/** Bitrate (mbps) and packet loss (%) from the delta between the current and previous samples. */
export function rateStats(cur: Sample, prev: Sample): { bitrateMbps: number; lossPct: number } {
  const dt = (cur.ts - prev.ts) / 1000; // seconds
  const bitrateMbps = dt > 0 ? round1(((cur.bytes - prev.bytes) * 8) / dt / 1_000_000) : 0;
  const dReceived = cur.packets - prev.packets;
  const dLost = cur.lost - prev.lost;
  const denom = dReceived + dLost;
  const lossPct = denom > 0 ? round1((dLost / denom) * 100) : 0;
  return { bitrateMbps: Math.max(0, bitrateMbps), lossPct: Math.max(0, lossPct) };
}
