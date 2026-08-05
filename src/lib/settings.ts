// Host quality settings: presets + the math that turns UI choices into WebRTC parameters.
// Pure and DOM/WebRTC-free so it's unit-testable; the wiring lives in host.ts.

/** The host resolution ladder, highest first. One literal: the type, the runtime validation in
 *  parseQuality and sourceTier's search all derive from it, so a tier can only ever be added or
 *  removed in one place. (The `data-res` buttons in HostScreen.astro mirror it by hand.) */
export const RESOLUTIONS = [2160, 1440, 1080, 720, 480] as const;
export type ResolutionTarget = (typeof RESOLUTIONS)[number]; // max output height (px); capped at the real source
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

// --- persistence ---

/** localStorage key. Note the store is per-ORIGIN: the desktop shell runs on `app://bundle` and
 *  the web on https, so the two keep separate settings. Not worth syncing — and `app://` only has
 *  localStorage at all because the scheme is registered as privileged (cf. docs/desktop.md). */
export const QUALITY_KEY = 'ss-quality';

const FPS_STEPS = new Set<number>([10, 30, 60, 120]); // mirrors the data-fps buttons
const BITRATE_MIN = 2; // mirrors #bitrate-range in HostScreen.astro
const BITRATE_MAX = 60;

/** What goes to storage. `mic` is deliberately left out — see parseQuality. */
export function serializeQuality(q: Quality): string {
  const { preset, resolution, fps, bitrate, systemAudio } = q;
  return JSON.stringify({ preset, resolution, fps, bitrate, systemAudio });
}

/**
 * Restore a persisted Quality, falling back to the default **field by field**.
 *
 * The argument for validating rather than trusting our own writes isn't a hostile user: it's our
 * own schema. This is an auto-updating desktop app reading a store written by an older version of
 * itself, so the day `120` leaves the fps ladder an all-or-nothing parse would also throw away the
 * bitrate and the preset that are still perfectly good.
 *
 * **`mic` is never restored**, even when present. It is the one setting with a privacy dimension:
 * restoring `true` would fire getUserMedia — and light the OS microphone indicator — on the first
 * capture of a session where nobody asked for it. Two clicks to turn it back on is the cheaper
 * mistake.
 */
export function parseQuality(raw: string | null): Quality {
  const q = { ...DEFAULT_QUALITY }; // a copy, never the shared object
  let data: unknown;
  try {
    data = raw === null ? null : JSON.parse(raw);
  } catch {
    return q;
  }
  if (!data || typeof data !== 'object') return q;
  const v = data as Record<string, unknown>;
  // hasOwn, not `in`: `'toString' in PRESETS` is true, and that value would reach contentHintFor
  // as PRESETS['toString'].contentHint → undefined, quietly poisoning setVideoParameters.
  if (v.preset === null || (typeof v.preset === 'string' && Object.hasOwn(PRESETS, v.preset))) {
    q.preset = v.preset as PresetName | null;
  }
  if (RESOLUTIONS.includes(v.resolution as ResolutionTarget)) q.resolution = v.resolution as ResolutionTarget;
  if (typeof v.fps === 'number' && FPS_STEPS.has(v.fps)) q.fps = v.fps;
  if (typeof v.bitrate === 'number' && Number.isInteger(v.bitrate) && v.bitrate >= BITRATE_MIN && v.bitrate <= BITRATE_MAX) {
    q.bitrate = v.bitrate;
  }
  if (typeof v.systemAudio === 'boolean') q.systemAudio = v.systemAudio;
  return q;
}

// --- HDR tone map exposure (desktop, native capture only) ---
//
// Kept OUT of `Quality`, and out of the store it writes, deliberately. Quality is quality maths
// that presets spread over; this is a correction to a physical measurement, and putting it there
// would force two exemptions immediately — presets must not reset it, and nudging it must not clear
// `preset`. A key of its own answers both by not asking.
//
// One value for the whole machine, not one per display, and that is a real limitation rather than
// an oversight: a host with a 480-nit panel and a 250-nit one gets the correction they found by eye
// on the first applied to the second, where it means something else. It is stored as a RELATIVE
// factor precisely so it transports better than an absolute would, and the "auto" button is the way
// out. Per-display keys the day someone actually calibrates two screens.

/** localStorage key for the tone-map exposure, in stops. Per-origin like the quality store. */
export const SDR_WHITE_KEY = 'ss-sdr-stops';
/** ±3 stops = an eighth to eight times the reported white. Sized by the case that motivates the
 *  control, not by taste: a display that reports nothing leaves the shell on the scRGB default of
 *  80 nits, which is 2.6 stops below the 480 measured here — at ±2 that user would hit the end of
 *  the slider still short of their own screen. Mirrored by the `<input>` in HostScreen.astro, which
 *  imports this constant rather than repeating it. */
export const SDR_STOPS_MAX = 3;

/** Exposure, not a percentage: the shader divides by this white, so the control is a multiplier and
 *  perception of brightness is logarithmic. `2 ** stops` also puts "as measured" at the exact centre
 *  of the slider, where a linear 50–200% would sit it a third of the way along. */
export function sdrWhiteFactor(stops: number): number {
  return 2 ** clampSdrStops(stops);
}

export function clampSdrStops(stops: number): number {
  if (!Number.isFinite(stops)) return 0;
  return Math.min(SDR_STOPS_MAX, Math.max(-SDR_STOPS_MAX, stops));
}

/** 0 (as reported) for anything unreadable — a stored value from another version, or none at all.
 *  `Number(null)` is 0, so the empty case needs no branch of its own. */
export function parseSdrStops(raw: string | null): number {
  return clampSdrStops(Number(raw));
}

/** Label for a host resolution tier: 4K / 2K for the top two, `${h}p` otherwise. */
export function resLabel(target: ResolutionTarget): string {
  return target === 2160 ? '4K' : target === 1440 ? '2K' : `${target}p`;
}

/** Highest resolution tier a source of this height can fill natively (floor 480). */
export function sourceTier(sourceHeight: number): ResolutionTarget {
  return RESOLUTIONS.find((t) => sourceHeight >= t) ?? 480; // 480 is both the floor and the last tier
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
  // System + mic are mixed into ONE Opus track (cf. AudioMixer), so the cost is not additive:
  // either something is sent or nothing is. 0.13 = the 128 kbps negotiated in tuneOpus.
  const audio = q.systemAudio || q.mic ? 0.13 : 0;
  return Math.round((q.bitrate + audio) * Math.max(1, viewers) * 10) / 10;
}

export function contentHintFor(q: Quality): ContentHint {
  return q.preset ? PRESETS[q.preset].contentHint : 'motion';
}

export function degradationFor(q: Quality): Degradation {
  return q.preset ? PRESETS[q.preset].degradation : 'balanced';
}
