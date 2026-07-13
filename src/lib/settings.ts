// Host quality settings: presets + the math that turns UI choices into WebRTC parameters.
// Pure and DOM/WebRTC-free so it's unit-testable; the wiring lives in host.ts.

export type ResolutionTarget = 2160 | 1440 | 1080 | 720 | 480; // max output height (px); capped at the real source
export type PresetName = 'gaming' | 'office' | 'cinema';
export type ContentHint = 'motion' | 'detail';
export type Degradation = 'maintain-framerate' | 'balanced';

export interface Quality {
  preset: PresetName | null; // null once the user tweaks a field by hand
  resolution: ResolutionTarget;
  fps: number;
  bitrate: number; // mbps (UI unit)
  systemAudio: boolean;
  mic: boolean;
}

// A preset is a one-click shortcut that sets resolution + fps + bitrate + content hint.
// ponytail: these numbers are sensible starting points, not gospel — tune from real streams.
export interface Preset {
  resolution: ResolutionTarget;
  fps: number;
  bitrate: number;
  contentHint: ContentHint;
  degradation: Degradation;
}
export const PRESETS: Record<PresetName, Preset> = {
  gaming: { resolution: 2160, fps: 60, bitrate: 20, contentHint: 'motion', degradation: 'maintain-framerate' },
  office: { resolution: 2160, fps: 10, bitrate: 4, contentHint: 'detail', degradation: 'balanced' },
  cinema: { resolution: 1080, fps: 30, bitrate: 12, contentHint: 'detail', degradation: 'balanced' },
};

export const DEFAULT_QUALITY: Quality = {
  preset: 'gaming',
  resolution: 2160, // "up to 4K" — effectiveScale caps it at the real source, so it means native for any ≤4K source
  fps: 60,
  bitrate: 20,
  systemAudio: true,
  mic: false,
};

/** Label for a host resolution tier: 4K / 2K for the top two, `${h}p` otherwise. */
export function resLabel(target: ResolutionTarget): string {
  return target === 2160 ? '4K' : target === 1440 ? '2K' : `${target}p`;
}

/** Highest resolution tier a source of this height can fill natively (floor 480). */
export function sourceTier(sourceHeight: number): ResolutionTarget {
  for (const t of [2160, 1440, 1080, 720] as const) if (sourceHeight >= t) return t;
  return 480;
}

/** Apply a preset's video fields onto the quality state (keeps audio/cursor untouched). */
export function applyPreset(q: Quality, name: PresetName): Quality {
  const p = PRESETS[name];
  return { ...q, preset: name, resolution: p.resolution, fps: p.fps, bitrate: p.bitrate };
}

// --- per-viewer quality (each viewer may request LOWER than the host cap, never higher) ---

export type ViewerTier = 'auto' | 'source' | 1440 | 1080 | 720 | 480;

/** Tiers a viewer can pick, capped at the host stream height (no upscale). Floor 480. */
export function viewerTiers(hostHeight: number): ViewerTier[] {
  const tiers: ViewerTier[] = ['auto', 'source'];
  for (const h of [1440, 1080, 720, 480] as const) if (h < hostHeight) tiers.push(h);
  return tiers;
}

/** scaleResolutionDownBy for a viewer's sender: cap at min(host target, viewer tier), never
 *  upscale. 'auto'/'source' add no extra cap beyond the host's — WebRTC still adapts below. */
export function effectiveScale(sourceHeight: number, hostTarget: ResolutionTarget, viewerTier: ViewerTier): number {
  if (sourceHeight <= 0) return 1;
  const viewerH = viewerTier === 'auto' || viewerTier === 'source' ? sourceHeight : viewerTier;
  return Math.max(1, sourceHeight / Math.min(hostTarget, viewerH)); // dividing sourceHeight never upscales
}

/** UI mbps → WebRTC maxBitrate in bits per second. */
export function maxBitrateBps(mbps: number): number {
  return Math.round(mbps * 1_000_000);
}

/** Rough TOTAL upload for the modal footer: in a mesh each viewer is a separate outgoing
 *  stream, so the cost scales with the viewer count (min 1 for display). */
export function estimatedUpload(q: Quality, viewers: number): number {
  const audio = (q.systemAudio ? 0.06 : 0) + (q.mic ? 0.05 : 0);
  return Math.round((q.bitrate + audio) * Math.max(1, viewers) * 10) / 10;
}

export function contentHintFor(q: Quality): ContentHint {
  return q.preset ? PRESETS[q.preset].contentHint : 'motion';
}

export function degradationFor(q: Quality): Degradation {
  return q.preset ? PRESETS[q.preset].degradation : 'balanced';
}
