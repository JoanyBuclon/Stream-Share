// Native capture addon for the desktop shell — first piece: is a display actually in HDR mode?
//
// This is the switch that decides whether the native capture path runs at all. It matters more than
// it looks: the native path is Windows-only C++ in the critical path of "share my screen", and the
// large majority of sessions are on SDR displays. Sending everyone through it would trade a
// reliability regression for a feature they cannot see. So: HDR on → native, otherwise the
// getDisplayMedia path that ships today, untouched.
//
// The web cannot answer this question. `matchMedia('(dynamic-range: high)')` reports the display's
// CAPABILITY, never whether the user has HDR switched on right now — which is the only thing that
// matters here. `IDXGIOutput6::GetDesc1` reports the compositor's live colour space.
//
// Plain N-API, no node-addon-api: one function returning an array does not justify a dependency,
// and this file has to build against Electron's ABI with as few moving parts as possible.

#include <node_api.h>

#include <utility>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_6.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <memory>
#include <optional>
#include <mutex>
#include <string>
#include <vector>

namespace {

struct DisplayHdr {
  std::wstring device_name;  // \\.\DISPLAY1 — what EnumDisplayDevices reports
  bool hdr;
  // See SdrWhiteNits below. Reported alongside `sdr_white_measured` because the fallback (80) is a
  // plausible-looking number: without the flag, JS cannot tell a real reading from a failed lookup,
  // and a failed lookup makes the tone map wrong by up to 6x.
  float sdr_white_nits;
  bool sdr_white_measured;
  float max_luminance_nits;
  // Desktop rectangle in PHYSICAL pixels. Electron never exposes the Windows device name of a
  // Display, so this rect is the only thing the two sides share: it is what lets the renderer say
  // "the screen the user picked is the HDR one" instead of "some screen is HDR".
  int32_t left, top, right, bottom;
};

/** Run something on the way out, however we leave. Enough of a scope guard for this file; the
 *  paths that need it are Unmap and returning a frame buffer to the pool, both of which are
 *  permanent-damage-if-skipped and reachable by three different throws. */
template <typename F>
class ScopeExit {
 public:
  explicit ScopeExit(F f) : f_(std::move(f)) {}
  ~ScopeExit() { f_(); }
  ScopeExit(const ScopeExit&) = delete;
  ScopeExit& operator=(const ScopeExit&) = delete;

 private:
  F f_;
};

/**
 * Reference white for SDR content while HDR is on, in nits.
 *
 * Not a constant, and not cosmetic: it is the divisor the tone map uses to decide what "white"
 * means, and Windows exposes it to the user as the "SDR content brightness" slider. Hardcoding the
 * scRGB definition (80) — as most samples do, and as this did until it was measured — makes the
 * whole picture wrong by whatever the user has dialled in, typically 2.5x.
 *
 * DXGI does not report it; only the DisplayConfig API does, and only per TARGET, which is why this
 * walks the path list to translate a GDI device name into an adapter/target pair.
 */
std::optional<float> SdrWhiteNits(const std::wstring& gdi_device_name) {
  constexpr float kScRgbWhite = 80.0f;  // scRGB 1.0, by definition
  std::vector<DISPLAYCONFIG_PATH_INFO> paths;
  std::vector<DISPLAYCONFIG_MODE_INFO> modes;
  // QueryDisplayConfig returns ERROR_INSUFFICIENT_BUFFER when the display topology changes between
  // sizing and reading — i.e. exactly when someone plugs in a monitor or toggles HDR, which is when
  // this gets called. Microsoft's own guidance is to retry.
  LONG status = ERROR_INSUFFICIENT_BUFFER;
  for (int attempt = 0; attempt < 3 && status == ERROR_INSUFFICIENT_BUFFER; ++attempt) {
    UINT32 path_count = 0, mode_count = 0;
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &path_count, &mode_count) != ERROR_SUCCESS) return {};
    paths.resize(path_count);
    modes.resize(mode_count);
    status = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &path_count, paths.data(), &mode_count, modes.data(), nullptr);
    paths.resize(status == ERROR_SUCCESS ? path_count : 0);
  }
  if (status != ERROR_SUCCESS) return {};

  for (const auto& path : paths) {
    DISPLAYCONFIG_SOURCE_DEVICE_NAME source{};
    source.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
    source.header.size = sizeof(source);
    source.header.adapterId = path.sourceInfo.adapterId;
    source.header.id = path.sourceInfo.id;
    if (DisplayConfigGetDeviceInfo(&source.header) != ERROR_SUCCESS) continue;
    if (gdi_device_name != source.viewGdiDeviceName) continue;

    DISPLAYCONFIG_SDR_WHITE_LEVEL white{};
    white.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL;
    white.header.size = sizeof(white);
    white.header.adapterId = path.targetInfo.adapterId;
    white.header.id = path.targetInfo.id;
    // `continue`, not `return`: in clone mode several paths share one GDI device name with
    // different targets, and the first one failing must not abandon the rest. (Which target wins in
    // clone mode is then arbitrary — they can disagree, and nothing here can pick correctly.)
    if (DisplayConfigGetDeviceInfo(&white.header) != ERROR_SUCCESS || !white.SDRWhiteLevel) continue;
    // The field is SDR white as a 1/1000 multiple of the scRGB reference.
    return static_cast<float>(white.SDRWhiteLevel) / 1000.0f * kScRgbWhite;
  }
  return {};
}

std::vector<DisplayHdr> QueryDisplays() {
  std::vector<DisplayHdr> out;
  winrt::com_ptr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), factory.put_void()))) return out;

  // FAILED, not == DXGI_ERROR_NOT_FOUND: any other error would leave a null pointer and loop
  // forever on it.
  for (UINT a = 0;; ++a) {
    winrt::com_ptr<IDXGIAdapter1> adapter;
    if (FAILED(factory->EnumAdapters1(a, adapter.put()))) break;
    for (UINT o = 0;; ++o) {
      winrt::com_ptr<IDXGIOutput> output;
      if (FAILED(adapter->EnumOutputs(o, output.put()))) break;
      // IDXGIOutput6 is where GetDesc1 lives (Windows 10 1703+). An older interface simply means
      // no HDR information available, which we report as "not HDR" rather than as an error.
      const auto output6 = output.try_as<IDXGIOutput6>();
      if (!output6) continue;
      DXGI_OUTPUT_DESC1 desc{};
      if (FAILED(output6->GetDesc1(&desc))) continue;

      DisplayHdr d{};
      d.device_name = desc.DeviceName;
      // G2084 = the PQ transfer function with BT.2020 primaries: the compositor is in HDR mode.
      // Anything else (including scRGB float on an SDR desktop) is not what we are looking for.
      d.hdr = desc.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
      d.max_luminance_nits = desc.MaxLuminance;
      const auto white = SdrWhiteNits(d.device_name);
      d.sdr_white_measured = white.has_value();
      d.sdr_white_nits = white.value_or(80.0f);
      d.left = desc.DesktopCoordinates.left;
      d.top = desc.DesktopCoordinates.top;
      d.right = desc.DesktopCoordinates.right;
      d.bottom = desc.DesktopCoordinates.bottom;
      out.push_back(std::move(d));
    }
  }
  return out;
}

napi_value ToJs(napi_env env, const std::vector<DisplayHdr>& displays) {
  napi_value arr;
  napi_create_array_with_length(env, displays.size(), &arr);
  for (size_t i = 0; i < displays.size(); ++i) {
    const auto& d = displays[i];
    napi_value obj, name, hdr, sdr_white, measured, max_lum;
    napi_create_object(env, &obj);
    napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(d.device_name.c_str()), d.device_name.size(), &name);
    napi_get_boolean(env, d.hdr, &hdr);
    napi_create_double(env, d.sdr_white_nits, &sdr_white);
    napi_get_boolean(env, d.sdr_white_measured, &measured);
    napi_create_double(env, d.max_luminance_nits, &max_lum);
    napi_set_named_property(env, obj, "deviceName", name);
    napi_set_named_property(env, obj, "hdr", hdr);
    napi_set_named_property(env, obj, "sdrWhiteNits", sdr_white);
    napi_set_named_property(env, obj, "sdrWhiteMeasured", measured);
    napi_set_named_property(env, obj, "maxLuminanceNits", max_lum);
    for (const auto& [key, value] : {std::pair{"left", d.left}, {"top", d.top}, {"right", d.right}, {"bottom", d.bottom}}) {
      napi_value v;
      napi_create_int32(env, value, &v);
      napi_set_named_property(env, obj, key, v);
    }
    napi_set_element(env, arr, static_cast<uint32_t>(i), obj);
  }
  return arr;
}

napi_value ListDisplays(napi_env env, napi_callback_info) {
  return ToJs(env, QueryDisplays());
}

// ---------------------------------------------------------------------------
// Windows Graphics Capture — the HDR path's source of frames.
//
// The budget for the whole chain is one frame at 60 Hz (16.7 ms), so every stage is timed here
// rather than guessed at. What is measured, precisely:
//
//   gap      — time between two frames' own timestamps. Source cadence. Note WGC is CHANGE-driven:
//              an idle desktop yields ~24 fps not because capture is slow but because nothing moved.
//   gpu      — handler entry until the readback Map() returns, i.e. tone map + copy + GPU sync.
//   copy     — memcpy of the mapped rows out of the staging texture.
//
// What is NOT measured, and why: `SystemRelativeTime` looks like a capture timestamp and is not.
// Measured against QPC in the handler it lands ~10 ms in the FUTURE (samples: -13.3 to +17.0 ms,
// mean -9.6), because it is DWM's target presentation time. It is a valid clock to diff against
// itself — hence `gap` — but subtracting it from "now" yields a negative latency, which is how this
// was caught rather than shipped.
// ---------------------------------------------------------------------------

namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgdx = winrt::Windows::Graphics::DirectX;

struct Tally {
  double max = 0, sum = 0;
  uint64_t n = 0;
  void Add(double v) {
    sum += v;
    n++;
    if (v > max) max = v;
  }
  double avg() const { return n ? sum / static_cast<double>(n) : 0.0; }
};

struct CaptureStats {
  uint64_t frames = 0;
  uint64_t recreated = 0;  // content resized: a mode change, or a game going fullscreen
  // Frames that ARRIVED and that our GPU path could not process. Deliberately not called "dropped":
  // frames WGC discards because its 2-buffer pool was full while we sat in Map() never reach the
  // handler at all, so nothing here can count them. The signal for those is `gap` — a drop shows up
  // as an inter-frame delta that is a multiple of the vsync interval.
  uint64_t failed = 0;
  uint64_t empty = 0;    // FrameArrived with nothing behind it (pool closed mid-flight)
  uint64_t dropped = 0;      // tone-mapped but JS was behind. THE backpressure signal.
  // Tone-mapped but never handed to JS (no buffer, or a detached one). Separate from `failed`
  // because the symptom differs: this one leaves every other counter green and the picture black.
  uint64_t skipped = 0;  // refused by the fps cap, before any GPU work
  uint64_t undelivered = 0;
  // The capture item went away: monitor unplugged, RDP session, HDR toggled off with Win+Alt+B.
  // Without this the frames simply stop, `running()` keeps saying true, and a viewer stares at a
  // frozen picture with no error anywhere.
  bool closed = false;
  int32_t width = 0, height = 0;
  Tally gap, gpu, copy;
};

// The tone map. scRGB in (BT.709 primaries, linear, 1.0 = 80 nits by definition), BT.709 SDR out.
//
// No gamut conversion: WGC's R16G16B16A16Float surface is already BT.709-primaried, with wide-gamut
// colours carried as NEGATIVE components rather than as BT.2020. That is the single biggest reason
// this shader is short — clamping those to zero is a real (small) gamut loss, and it is what every
// SDR sink does anyway.
//
// The curve is an exponential shoulder above a fixed knee, NOT extended Reinhard, and that was a
// measurement not a preference. Reinhard is a scene-referred operator: it maps SDR white to
// (1+1/w²)/2, so with this machine's 480-nit SDR white and 760-nit peak it delivered white at 219
// instead of 255 and a mean luma of 11. It darkens the 99% of the frame that was never HDR in order
// to make room for the 1% that is.
//
// The shoulder keeps everything below the knee EXACTLY as it was — an SDR desktop round-trips
// unchanged — and rolls the highlights above it asymptotically into 1.0. It is C¹ at the knee
// (slope 1 on both sides), so there is no visible band where the curve changes.
//
// ponytail: fixed knee, no BT.2390 EETF. BT.2390 wants a PQ round trip and a spline; this is two
// lines and is judged by the same measurement the OBS pilot passed (tools/wgc-latency.cjs).
// ponytail: per-channel, so a saturated highlight shifts hue as it desaturates towards white. The
// usual trade against a luminance-based operator; swap if that ever shows up in a real capture.
constexpr char kShaderHlsl[] = R"(
Texture2D<float4> src : register(t0);
SamplerState smp : register(s0);
cbuffer Params : register(b0) { float sdrWhite; float knee; float2 uvScale; };

struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

VSOut VSMain(uint id : SV_VertexID) {
  VSOut o;
  o.uv = float2((id << 1) & 2, id & 2);
  o.pos = float4(o.uv * float2(2, -2) + float2(-1, 1), 0, 1);
  return o;
}

float3 Shoulder(float3 c, float k) {
  // Below k: identity. Above: 1 - (1-k)*exp(-(c-k)/(1-k)), which starts at k with slope 1 and
  // approaches 1 asymptotically.
  float3 over = 1.0 - (1.0 - k) * exp(-(c - k) / (1.0 - k));
  return (c <= k) ? c : over;
}

float4 PSMain(VSOut i) : SV_Target {
  // uvScale: WGC only guarantees its pool texture is AT LEAST ContentSize, never equal. Sampling
  // the full texture stretches the image for every frame between a resolution change and the
  // pool.Recreate that follows it — which is precisely when a game goes fullscreen.
  float3 c = max(src.Sample(smp, i.uv * uvScale).rgb, 0.0);
  c *= 80.0 / sdrWhite;            // SDR reference white becomes 1.0
  c = saturate(Shoulder(c, knee));
  // sRGB encode, not BT.709's OETF: the destination is a BGRA8 surface that Chromium treats as
  // sRGB, so matching it is what keeps the round trip neutral.
  c = (c <= 0.0031308) ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
  return float4(c, 1.0);
}
)";

struct ShaderParams {
  float sdr_white = 80.0f;
  // Where highlight roll-off starts, in SDR-white units. 0.75 leaves the whole UI untouched and
  // still gives the shoulder enough range to be smooth.
  float knee = 0.75f;
  float uv_scale[2] = {1.0f, 1.0f};
};

/** One tone-mapped frame on its way to JS. Heap-allocated and owned by the threadsafe function's
 *  queue, so the WGC thread never waits for the JS thread to catch up. */
struct FramePayload {
  std::vector<uint8_t> pixels;  // BGRA8, tightly packed
  int32_t width = 0, height = 0;
  int64_t timestamp_us = 0;
};

/**
 * One capture, and the threading rule that makes it safe.
 *
 * `FrameArrived` fires on a WinRT thread-pool thread — plural, in principle: nothing in WGC
 * promises two handlers never overlap, and with a readback that blocks for ~5 ms there is real
 * room for a second one to enter. `ID3D11DeviceContext` is **not** free-threaded (the device is;
 * the immediate context is not), so two concurrent handlers would corrupt its state machine.
 *
 * And `stopCapture()` arrives from the JS thread while all that is in flight. Revoking the
 * FrameArrived token stops NEW dispatches; it does not join a handler that is already running, and
 * it certainly does not unblock one sitting inside `Map()`. Releasing the device under it is a
 * use-after-free with a timing window wide enough to hit a user and narrow enough to miss a bench.
 *
 * So: `pipeline_m_` serialises the ENTIRE frame path and the teardown. Stop() revokes first without
 * the lock (so it can never deadlock against a handler waiting for it), then takes the lock, which
 * is what actually waits for the in-flight frame. A handler that wakes up after teardown finds
 * `ctx_` null and leaves.
 *
 * `stats_m_` stays separate and is only ever held for a few field writes, so polling stats cannot
 * stall capture. That split matters: `LastFrame` used to copy 14 MB under the frame lock, i.e. the
 * measurement tool slowed down the cadence it was measuring.
 */
class CaptureSession {
 public:
  bool Start(HMONITOR monitor, float sdr_white, napi_threadsafe_function sink, std::string* err);
  /** The same pipeline against a single WINDOW instead of a monitor — how an app on an HDR screen
   *  gets captured at all, since desktopCapturer ties no window to a display. Measured before it
   *  was built (tools/window-hdr-probe.cjs): WGC hands back scRGB anchored on the reference white
   *  of whichever display the window is on, so the tone map is unchanged — but the divisor has to
   *  follow the window across screens, which is what CurrentDisplay() is for. */
  bool StartWindow(HWND window, float sdr_white, napi_threadsafe_function sink, std::string* err);
  /** `drop_device`: also release the cached D3D device and pipeline. Default false — they are kept
   *  across a stop on purpose, see the comment in Stop(). True on a failed start and at teardown. */
  void Stop(bool drop_device = false);
  CaptureStats Snapshot();
  /** A frame that was tone-mapped but could not be handed to JS (no buffer, or a detached one).
   *  Counted separately from `failed`, which is about the GPU path, because the symptom differs:
   *  this one delivers a green dashboard and a black picture. */
  void CountBufferFailure() {
    std::lock_guard<std::mutex> lock(stats_m_);
    stats_.undelivered++;
  }
  /** Called by the threadsafe function's finalizer. Node runs env cleanup hooks LIFO, and the
   *  function registers its own when created — i.e. AFTER ours — so on teardown it is destroyed
   *  first and our hook would release a dead pointer. Forgetting it here makes order irrelevant. */
  void ForgetSink() { sink_.store(nullptr, std::memory_order_release); }
  /** Cap delivery to `fps` frames a second, or 0 for uncapped. Live, because the settings modal
   *  changes fps mid-session and restarting a capture to honour a slider would be absurd. */
  void SetFps(double fps) {
    const double slack = 0.995;  // so a 60 Hz source is not decimated to 30 by rounding
    min_interval_100ns_.store(fps > 0 ? static_cast<int64_t>(10000000.0 / fps * slack) : 0,
                              std::memory_order_relaxed);
  }
  /**
   * The tone map's divisor, live. Windows reports a reference white per display, but it is the
   * user's own brightness slider — so the reading can be right and the result still not what they
   * want, and there was no way to say so.
   *
   * Recorded here and applied in OnFrame, NOT written to the constant buffer from this thread:
   * `ID3D11DeviceContext` is not free-threaded (the device is), and this is called from the JS
   * thread while the WGC thread may be mid-frame. Taking `pipeline_m_` here instead would be legal
   * but would park the renderer behind an in-flight `Map()` on every tick of a slider drag.
   *
   * Rejected rather than clamped when it is not a usable number: 0 divides the whole picture into
   * infinities and a NaN propagates to every pixel, so the caller keeps whatever was set before —
   * a control that refuses a bad value is better than one that invents a plausible one. `!(f >= …)`
   * rather than `f < …` so NaN, which compares false against everything, is caught by the same test.
   */
  void SetSdrWhite(double nits) {
    const float f = static_cast<float>(nits);
    // Checked AFTER the cast, and against a physical range rather than just finiteness: 1e300 is a
    // perfectly finite double that becomes +inf as a float, and 80/inf is a permanently black
    // screen. 1 to 10000 nits covers every display that exists and every value the slider can
    // produce; this method is on the contextBridge, so it is reachable with anything.
    if (!(f >= 1.0f && f <= 10000.0f)) return;
    want_sdr_white_.store(f, std::memory_order_relaxed);
  }
  bool running() const { return session_ != nullptr; }
  /** Exactly one of the two is set — WGC has a separate factory call per kind and nothing else in
   *  the pipeline cares which one produced the item. */
  struct ItemTarget {
    HMONITOR monitor;
    HWND window;
  };
  /**
   * What this session is pointed at, for the JS thread to re-read the display state from.
   *
   * Written in StartItem and Stop, read in GetCaptureStats — all on the JS thread, so no
   * synchronisation. Deliberately NOT consulted from OnFrame: resolving a display walks the
   * DisplayConfig path list, and doing that under `pipeline_m_` would make Stop() wait on it and
   * hiccup a frame, for a value nobody needs at frame rate.
   */

  /** The reference white of the display this session is on RIGHT NOW, plus whether the window (if
   *  it is a window) is minimised. Polled at 10 Hz by the page, which owns the divisor: it is the
   *  reported white times the host's own correction, and only the page knows that factor.
   *
   *  Re-read every call rather than cached on the monitor handle. Measured at 0.286 ms for the
   *  whole display list, i.e. 0.06% of a core at that rate — and re-reading is what makes moving
   *  the WINDOWS SDR brightness slider mid-share take effect, on both paths, for free. */
  struct DisplayState {
    float sdr_white_nits = 0.0f;
    bool sdr_white_measured = false;
    bool minimized = false;
  };
  /** Per-stage cost of the last StartItem, in ms. The whole call is synchronous C++ on the thread
   *  that asked for it — the renderer's — so the click on "share" pays every line of it, and one
   *  aggregate number cannot say which line to attack. Written and read on the JS thread. */
  struct StartupTiming {
    double apartment = 0, supported = 0, device = 0, compileVs = 0, compilePs = 0, pipelineRest = 0;
    double buffer = 0, rtDevice = 0, item = 0, pool = 0, session = 0, total = 0;
  };
  StartupTiming Startup() const { return startup_; }
  /** Create the device and pipeline ahead of the first capture, if they are not already there.
   *  Safe to call at any time: with a capture running the device exists, so this is a read. */
  void WarmUp();
  DisplayState CurrentDisplay() const;
  /** Moved out, not copied: the caller gets the buffer and the session allocates a fresh one. */
  std::vector<uint8_t> TakeFrame(int32_t* w, int32_t* h);

 private:
  bool StartItem(ItemTarget target, float sdr_white, napi_threadsafe_function sink, std::string* err);
  /** What this session is pointed at — see the DisplayState docblock above. Private, because the
   *  invariant they carry is "JS thread only" and a public member invites the opposite. */
  HWND window_ = nullptr;
  std::wstring monitor_device_;
  void OnFrame(wgc::Direct3D11CaptureFramePool const& pool, winrt::Windows::Foundation::IInspectable const&);
  bool BuildPipeline(std::string* err);
  bool EnsureTargets(int32_t width, int32_t height);
  bool ToneMap(ID3D11Texture2D* source, int32_t width, int32_t height, int32_t content_w, int32_t content_h);
  /** False when the constant buffer could not be mapped — see the call site in OnFrame. */
  bool UploadParams();  // caller holds pipeline_m_

  // --- GPU pipeline: touched only under pipeline_m_ ---
  StartupTiming startup_{};
  std::mutex pipeline_m_;
  winrt::com_ptr<ID3D11Device> d3d_;
  winrt::com_ptr<ID3D11DeviceContext> ctx_;
  winrt::com_ptr<ID3D11VertexShader> vs_;
  winrt::com_ptr<ID3D11PixelShader> ps_;
  winrt::com_ptr<ID3D11SamplerState> sampler_;
  winrt::com_ptr<ID3D11Buffer> params_;
  winrt::com_ptr<ID3D11Texture2D> target_;   // BGRA8 render target
  winrt::com_ptr<ID3D11RenderTargetView> rtv_;
  winrt::com_ptr<ID3D11Texture2D> staging_;  // CPU-readable copy of the above
  ShaderParams params_cpu_{};
  int32_t target_w_ = 0, target_h_ = 0;    // size of our own render/staging pair
  int32_t content_w_ = 0, content_h_ = 0;  // size the frame pool is currently configured for
  int64_t prev_frame_100ns_ = 0;
  int64_t prev_kept_100ns_ = 0;  // last frame actually processed, for the fps cap

  // --- WinRT objects: written on the JS thread in Start/Stop, read in OnFrame under pipeline_m_ ---
  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice rt_device_{nullptr};
  wgc::GraphicsCaptureItem item_{nullptr};
  wgc::Direct3D11CaptureFramePool pool_{nullptr};
  wgc::GraphicsCaptureSession session_{nullptr};
  winrt::event_token frame_token_{};
  winrt::event_token closed_token_{};

  // --- Readable from either thread ---
  std::mutex stats_m_;
  CaptureStats stats_;
  // Only filled when nobody is subscribed: with a sink, frames go straight out and keeping a copy
  // here would be a second memcpy of 8 MB per frame for a debug accessor nobody is reading.
  std::vector<uint8_t> frame_;  // BGRA8, tightly packed
  int32_t frame_w_ = 0, frame_h_ = 0;

  // Set once in Start, released in Stop, called from the WGC thread. Its queue holds ONE frame and
  // is non-blocking, so the property is NEVER QUEUE — not "newest wins", which is what this said
  // until someone read it against the API: with the queue full, `napi_tsfn_nonblocking` rejects the
  // ARRIVING frame and keeps the one already queued. Under sustained overload we therefore deliver
  // a frame that is one late, not the freshest. That is still the right trade against a growing
  // queue, which turns a momentary stall into latency that never comes back — but it is not what
  // the old wording promised.
  // Atomic because the WGC thread reads it while the JS thread (Start, Stop, and the threadsafe
  // function's own finalizer) writes it.
  std::atomic<napi_threadsafe_function> sink_{nullptr};
  std::atomic<int64_t> min_interval_100ns_{0};  // 0 = uncapped
  /** Set from the JS thread by SetSdrWhite, consumed by the WGC thread in OnFrame. 0 = nothing
   *  pending; the value in flight is never read back, so a store that lands between two frames
   *  simply wins. */
  std::atomic<float> want_sdr_white_{0.0f};
  int64_t first_frame_100ns_ = 0;
};

bool CaptureSession::BuildPipeline(std::string* err) {
  auto compile = [&](const char* entry, const char* profile, winrt::com_ptr<ID3DBlob>& blob) -> bool {
    winrt::com_ptr<ID3DBlob> errors;
    const HRESULT hr = D3DCompile(kShaderHlsl, sizeof(kShaderHlsl) - 1, "streamshare_tonemap", nullptr, nullptr,
                                  entry, profile, D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, blob.put(), errors.put());
    if (FAILED(hr)) {
      *err = errors ? std::string(static_cast<const char*>(errors->GetBufferPointer()), errors->GetBufferSize())
                    : "shader compilation failed";
      return false;
    }
    return true;
  };
  winrt::com_ptr<ID3DBlob> vs_blob, ps_blob;
  auto t0 = std::chrono::steady_clock::now();
  const auto since = [](std::chrono::steady_clock::time_point& mark) {
    const auto now = std::chrono::steady_clock::now();
    const double ms = std::chrono::duration<double, std::milli>(now - mark).count();
    mark = now;
    return ms;
  };
  if (!compile("VSMain", "vs_5_0", vs_blob)) return false;
  startup_.compileVs = since(t0);
  if (!compile("PSMain", "ps_5_0", ps_blob)) return false;
  startup_.compilePs = since(t0);
  winrt::check_hresult(
      d3d_->CreateVertexShader(vs_blob->GetBufferPointer(), vs_blob->GetBufferSize(), nullptr, vs_.put()));
  winrt::check_hresult(
      d3d_->CreatePixelShader(ps_blob->GetBufferPointer(), ps_blob->GetBufferSize(), nullptr, ps_.put()));

  D3D11_SAMPLER_DESC sd{};
  sd.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;  // 1:1 blit, so no filtering to pay for
  sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
  winrt::check_hresult(d3d_->CreateSamplerState(&sd, sampler_.put()));
  startup_.pipelineRest = since(t0);
  return true;
}

bool CaptureSession::EnsureTargets(int32_t width, int32_t height) {
  if (target_ && target_w_ == width && target_h_ == height) return true;
  target_ = nullptr;
  rtv_ = nullptr;
  staging_ = nullptr;
  // Cleared up front, so a failure below leaves "no targets for any size" rather than a stale size
  // that makes every subsequent frame look like a resize and re-Recreate the pool on a GPU that is
  // already out of memory.
  target_w_ = target_h_ = 0;
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = static_cast<UINT>(width);
  desc.Height = static_cast<UINT>(height);
  desc.MipLevels = desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_RENDER_TARGET;
  if (FAILED(d3d_->CreateTexture2D(&desc, nullptr, target_.put()))) return false;
  if (FAILED(d3d_->CreateRenderTargetView(target_.get(), nullptr, rtv_.put()))) return false;
  desc.Usage = D3D11_USAGE_STAGING;
  desc.BindFlags = 0;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  if (FAILED(d3d_->CreateTexture2D(&desc, nullptr, staging_.put()))) return false;
  target_w_ = width;
  target_h_ = height;
  return true;
}

bool CaptureSession::Start(HMONITOR monitor, float sdr_white, napi_threadsafe_function sink,
                           std::string* err) {
  return StartItem(ItemTarget{monitor, nullptr}, sdr_white, sink, err);
}

bool CaptureSession::StartWindow(HWND window, float sdr_white, napi_threadsafe_function sink,
                                 std::string* err) {
  return StartItem(ItemTarget{nullptr, window}, sdr_white, sink, err);
}

/** Machine-constant, and it measured 14-19 ms EVERY time it was called. A free function rather than
 *  a static inside StartItem, so the warm-up below can prime it too — otherwise the first start
 *  still paid it even with a warm device. */
static bool WgcSupported() {
  static const bool supported = wgc::GraphicsCaptureSession::IsSupported();
  return supported;
}

void CaptureSession::WarmUp() {
  // The lock costs nothing here — this runs off every hot path — and it is the only mutator of
  // d3d_/ctx_ that did not take it. Safe without it today only because the early return cannot fire
  // while a session is live, which is an invariant spread over three functions with no assert.
  std::lock_guard<std::mutex> pipeline(pipeline_m_);
  if (d3d_) return; // already built, by a warm-up or by a capture that is still running
  try {
    // Same as StartItem's, and needed for the same reason: COM on this thread. Cheap (0.1 ms
    // measured) and it throws RPC_E_CHANGED_MODE on a thread that already has an apartment.
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch (winrt::hresult_error const&) {
    }
    WgcSupported(); // primed here so the first real start does not pay it
    winrt::com_ptr<ID3D11Device> device;
    winrt::com_ptr<ID3D11DeviceContext> ctx;
    winrt::check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                           nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, ctx.put()));
    // Published only once BOTH halves exist: StartItem reads `d3d_` alone to decide whether the
    // pipeline is cached too, so a device left behind by a failed BuildPipeline would be taken for
    // a complete one and the shaders would never be built.
    d3d_ = device;
    ctx_ = ctx;
    std::string err;
    // params_ is deliberately absent below: BuildPipeline does not create it, StartItem does. So a
    // warm-up skips the constant buffer, which costs microseconds.
    if (!BuildPipeline(&err)) {
      vs_ = nullptr;
      ps_ = nullptr;
      sampler_ = nullptr;
      ctx_ = nullptr;
      d3d_ = nullptr;
    }
  } catch (winrt::hresult_error const&) {
    // Swallowed on purpose: a warm-up that fails costs nothing but the time the start was going to
    // spend anyway, and there is no caller to tell.
    ctx_ = nullptr;
    d3d_ = nullptr;
  }
}

bool CaptureSession::StartItem(ItemTarget target, float sdr_white, napi_threadsafe_function sink,
                               std::string* err) {
  // Takes ownership of `sink` on every path, including the failures — split ownership between here
  // and the caller is how a threadsafe function gets released twice.
  if (session_) {
    *err = "capture already running";
    if (sink) napi_release_threadsafe_function(sink, napi_tsfn_release);
    return false;
  }
  sink_.store(sink, std::memory_order_release);
  startup_ = StartupTiming{};
  const auto t_start = std::chrono::steady_clock::now();
  auto t_mark = t_start;
  const auto since = [](std::chrono::steady_clock::time_point& mark) {
    const auto now = std::chrono::steady_clock::now();
    const double ms = std::chrono::duration<double, std::milli>(now - mark).count();
    mark = now;
    return ms;
  };
  try {
    // COM has to be initialized on this thread; which apartment does not matter, because the frame
    // pool below is free-threaded and delivers on its own thread either way. RPC_E_CHANGED_MODE
    // means the thread already has an apartment (Electron's main and renderer threads do), which is
    // exactly as good. No matching uninit_apartment: we did not necessarily initialize it, and
    // uninitializing a thread we do not own would break whatever else lives on it.
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch (winrt::hresult_error const&) {
    }
    startup_.apartment = since(t_mark);
    if (!WgcSupported()) {
      *err = "Windows Graphics Capture is not supported on this machine";
      // Stop(), not a bare return: `sink_` is already set, and this is the one failure path that
      // used to skip the release — leaking the threadsafe function, which keeps a reference on the
      // environment so the renderer can never tear down cleanly. And of course the machine that
      // takes this path is the one nobody develops on.
      Stop(/*drop_device=*/true);
      return false;
    }
    startup_.supported = since(t_mark);
    // A device kept from a previous session, if it is still usable. GetDeviceRemovedReason covers
    // TDR, a driver update, a GPU reset and adapter removal — all of which surface as
    // DXGI_ERROR_DEVICE_*. It is the fast path, not the only defence: the catch below drops the
    // cache too, so a device that dies between here and StartCapture cannot poison every later
    // start.
    if (d3d_ && d3d_->GetDeviceRemovedReason() != S_OK) {
      vs_ = nullptr;
      ps_ = nullptr;
      sampler_ = nullptr;
      params_ = nullptr;
      ctx_ = nullptr;
      d3d_ = nullptr;
    }
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    // ponytail: default adapter, not the one that owns the HMONITOR. On a hybrid or dual-GPU
    // machine that costs a cross-adapter copy per frame. Invisible on the single-GPU box this was
    // measured on; QueryDisplays already walks the adapters if it ever needs fixing.
    if (!d3d_) {
      winrt::check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, nullptr, 0,
                                             D3D11_SDK_VERSION, d3d_.put(), nullptr, ctx_.put()));
      startup_.device = since(t_mark);
      if (!BuildPipeline(err)) {
        Stop(/*drop_device=*/true);
        return false;
      }
    }
    // A zero here is the cache-hit signal, and the harness gates on exactly that — see the "stop
    // then start again" gate in tools/native-track.cjs.
    t_mark = std::chrono::steady_clock::now();
    // DYNAMIC, not IMMUTABLE: the SDR white level is a live value. Windows lets the user move its
    // own slider mid-session, and ours exposes it too (see SetSdrWhite). Baking it in would mean
    // tearing down the device and the capture session to change one float.
    const float want = sdr_white > 0 ? sdr_white : 80.0f;
    if (!params_) {
      D3D11_BUFFER_DESC bd{};
      bd.ByteWidth = sizeof(ShaderParams);
      bd.Usage = D3D11_USAGE_DYNAMIC;
      bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
      bd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
      // The knee stays at the ShaderParams default. It was a parameter for a while and never had a
      // caller: the settings modal exposes the reference white (which the user can judge by looking)
      // and not the curve shape (which they cannot). Making it configurable again means a UI for it.
      const ShaderParams initial{want, ShaderParams{}.knee, {1.0f, 1.0f}};
      D3D11_SUBRESOURCE_DATA init{&initial, 0, 0};
      winrt::check_hresult(d3d_->CreateBuffer(&bd, &init, params_.put()));
      params_cpu_ = initial;
    }
    startup_.buffer = since(t_mark);
    // Overwritten HERE, unconditionally, and this is load-bearing twice over. Before the cache it
    // was a CLEAR, because setSdrWhite has no running() guard and a value set before the first
    // capture of the process must not overwrite the one this Start was given. Now the buffer can be
    // a REUSED one still holding the previous session's divisor, so this is also how the new value
    // reaches the GPU: ToneMap picks the atomic up on the first frame and uploads it on the WGC
    // thread, under pipeline_m_, before the Draw. Doing it here with ctx_->Map would be the first
    // context call on the JS thread in this file, which is precisely the rule the mutex encodes.
    want_sdr_white_.store(want, std::memory_order_relaxed);

    winrt::com_ptr<::IInspectable> inspectable;
    winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(d3d_.as<IDXGIDevice>().get(), inspectable.put()));
    rt_device_ = inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();

    startup_.rtDevice = since(t_mark);
    auto interop = winrt::get_activation_factory<wgc::GraphicsCaptureItem, ::IGraphicsCaptureItemInterop>();
    // Remembered for the display poll on the JS thread (see CurrentDisplay). For a monitor
    // the device name is fixed for the session; for a window it is resolved each time, because the
    // window can be dragged to another screen.
    window_ = target.window;
    monitor_device_.clear();
    if (target.monitor) {
      MONITORINFOEXW info{};
      info.cbSize = sizeof(info);
      if (GetMonitorInfoW(target.monitor, &info)) monitor_device_ = info.szDevice;
    }
    winrt::check_hresult(target.monitor ? interop->CreateForMonitor(target.monitor, winrt::guid_of<wgc::GraphicsCaptureItem>(),
                                                                      winrt::put_abi(item_))
                                        : interop->CreateForWindow(target.window, winrt::guid_of<wgc::GraphicsCaptureItem>(),
                                                                   winrt::put_abi(item_)));

    // R16G16B16A16Float is the whole point: it is scRGB, so HDR highlights arrive above 1.0 instead
    // of clamped the way getDisplayMedia's BGRA8 delivers them. Two buffers, because a deeper pool
    // only buys latency we are trying not to spend.
    startup_.item = since(t_mark);
    pool_ = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(
        rt_device_, wgdx::DirectXPixelFormat::R16G16B16A16Float, 2, item_.Size());
    startup_.pool = since(t_mark);
    content_w_ = item_.Size().Width;
    content_h_ = item_.Size().Height;
    frame_token_ = pool_.FrameArrived({this, &CaptureSession::OnFrame});
    // Without this the frames simply stop when the monitor goes away and nothing ever says so.
    closed_token_ = item_.Closed([this](auto&&, auto&&) {
      std::lock_guard<std::mutex> lock(stats_m_);
      stats_.closed = true;
    });
    session_ = pool_.CreateCaptureSession(item_);
    // The pointer stays. getDisplayMedia shows it, so hiding it here would make turning HDR on
    // silently lose the mouse — and docs/desktop.md already records cursor removal as a
    // non-request. Left explicit rather than defaulted, because the default is not obvious.
    session_.IsCursorCaptureEnabled(true);
    // Win11-only, and on 24H2 it can additionally require a capture-access grant. Best effort: the
    // yellow border is cosmetic, and refusing to capture over it would be worse.
    try {
      // Static for the same reason as IsSupported above: this is a WinRT metadata lookup, it is an
      // OS constant, and it sat in the ~7 ms `session` stage on every single start.
      static const bool kHasBorderFlag = winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
          L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired");
      if (kHasBorderFlag) {
        session_.IsBorderRequired(false);
      }
    } catch (winrt::hresult_error const&) {
    }
    session_.StartCapture();
    startup_.session = since(t_mark);
    startup_.total = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t_start).count();
    return true;
  } catch (winrt::hresult_error const& e) {
    *err = winrt::to_string(e.message());
    // A start that threw must not leave its half-built device behind: the throw can BE the device
    // dying, and caching that would turn one transient failure into a permanently broken capture.
    Stop(/*drop_device=*/true);
    return false;
  }
}

bool CaptureSession::ToneMap(ID3D11Texture2D* source, int32_t width, int32_t height, int32_t content_w,
                             int32_t content_h) {
  if (!EnsureTargets(content_w, content_h)) return false;
  winrt::com_ptr<ID3D11ShaderResourceView> srv;
  if (FAILED(d3d_->CreateShaderResourceView(source, nullptr, srv.put()))) return false;

  // The pool texture can be larger than the content; sample only the part that is real. Recomputed
  // per frame because it is one float pair and the alternative is a cache invalidated by the same
  // events that change it.
  const float u = width > 0 ? static_cast<float>(content_w) / static_cast<float>(width) : 1.0f;
  const float v = height > 0 ? static_cast<float>(content_h) / static_cast<float>(height) : 1.0f;
  // The pending SDR white, if the settings slider moved since the last frame. Same
  // compare-then-upload as uvScale below, and the same buffer, so a frame that changes both pays
  // one Map instead of two.
  // ponytail: applied on the next REAL frame. WGC is change-driven, so on a perfectly still screen
  // the slider does nothing visible until something moves (the cursor is captured, so moving the
  // mouse is enough). Forcing a redraw would mean keeping the source scRGB texture alive — ~33 MB
  // at 4K plus a copy per frame, paid forever for a control used once.
  bool params_dirty = false;
  const float wanted = want_sdr_white_.exchange(0.0f, std::memory_order_relaxed);
  if (wanted > 0 && wanted != params_cpu_.sdr_white) {
    params_cpu_.sdr_white = wanted;
    params_dirty = true;
  }
  if (u != params_cpu_.uv_scale[0] || v != params_cpu_.uv_scale[1]) {
    params_cpu_.uv_scale[0] = u;
    params_cpu_.uv_scale[1] = v;
    params_dirty = true;
  }
  // Re-armed on failure, not dropped: `params_cpu_` has already been updated, so the next frame
  // would see nothing dirty and the host's correction would be gone for good. WRITE_DISCARD only
  // fails on a removed device, but "lost silently and for ever" is the wrong way to lose.
  if (params_dirty && !UploadParams() && wanted > 0) {
    want_sdr_white_.store(wanted, std::memory_order_relaxed);
  }

  D3D11_VIEWPORT vp{0.0f, 0.0f, static_cast<float>(content_w), static_cast<float>(content_h), 0.0f, 1.0f};
  ID3D11RenderTargetView* rtvs[] = {rtv_.get()};
  ID3D11ShaderResourceView* srvs[] = {srv.get()};
  ID3D11SamplerState* samplers[] = {sampler_.get()};
  ID3D11Buffer* buffers[] = {params_.get()};
  // No vertex buffer and no input layout: the vertex shader builds a full-screen triangle from
  // SV_VertexID. The one per-frame allocation left is the shader resource view above — the pool
  // only ever cycles two textures, so a two-entry cache would remove it, but it sits inside the
  // measured 5 ms and caching it would need invalidating on every Recreate.
  ctx_->IASetInputLayout(nullptr);
  ctx_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  ctx_->VSSetShader(vs_.get(), nullptr, 0);
  ctx_->PSSetShader(ps_.get(), nullptr, 0);
  ctx_->PSSetShaderResources(0, 1, srvs);
  ctx_->PSSetSamplers(0, 1, samplers);
  ctx_->PSSetConstantBuffers(0, 1, buffers);
  ctx_->OMSetRenderTargets(1, rtvs, nullptr);
  ctx_->RSSetViewports(1, &vp);
  ctx_->Draw(3, 0);
  // Unbind before returning: the frame pool recycles its textures, so leaving this one bound as a
  // shader resource makes the next frame's write to it a hazard the runtime resolves by stalling.
  ID3D11ShaderResourceView* unbind[] = {nullptr};
  ctx_->PSSetShaderResources(0, 1, unbind);
  ctx_->CopyResource(staging_.get(), target_.get());
  return true;
}

void CaptureSession::OnFrame(wgc::Direct3D11CaptureFramePool const& pool,
                             winrt::Windows::Foundation::IInspectable const&) {
  using clock = std::chrono::steady_clock;
  const auto elapsed = [](clock::time_point from, clock::time_point to) {
    return std::chrono::duration<double, std::milli>(to - from).count();
  };

  // Everything below runs under this lock — see the class comment. It is what makes a concurrent
  // second handler safe on a non-free-threaded device context, and what makes Stop() wait for us.
  std::lock_guard<std::mutex> pipeline(pipeline_m_);
  // `pool != pool_`, not just `!ctx_`. The context check alone used to mean "Stop() ran while this
  // dispatch was queued", but the context now SURVIVES a stop, so that guard would let a dispatch
  // belonging to a dead pool through: TryGetNextFrame on a closed pool throws RO_E_CLOSED, the catch
  // below swallows it, and the failure is billed to the NEXT session's freshly-zeroed stats. WinRT
  // projections compare by ABI pointer, so this is exact — and it also covers the stop-start-then-
  // stale-wakeup ordering the old guard never did.
  if (!ctx_ || pool != pool_) return;

  const auto t0 = clock::now();
  bool ok = false, resized = false;
  double gpu_ms = 0, copy_ms = 0;
  int32_t frame_w = 0, frame_h = 0;
  int64_t stamp = 0;
  winrt::Windows::Graphics::SizeInt32 size{};
  try {
    auto frame = pool.TryGetNextFrame();
    if (!frame) {
      std::lock_guard<std::mutex> lock(stats_m_);
      stats_.empty++;
      return;
    }
    // Close the frame however we leave — a buffer never returned starves a pool of two.
    const auto give_back = ScopeExit([&] { frame.Close(); });
    stamp = frame.SystemRelativeTime().count();
    size = frame.ContentSize();
    resized = size.Width != content_w_ || size.Height != content_h_;

    // The fps cap, applied HERE — before the tone map and the readback, which is the whole point.
    // Capping downstream (in the preload, or by dropping writes) would still pay ~7 ms of GPU per
    // frame we then throw away. `applyConstraints({frameRate})` cannot do this for us: a
    // MediaStreamTrackGenerator refuses it outright (OverconstrainedError, measured).
    const int64_t min_interval = min_interval_100ns_.load(std::memory_order_relaxed);
    if (min_interval > 0 && prev_kept_100ns_ && stamp - prev_kept_100ns_ < min_interval) {
      std::lock_guard<std::mutex> lock(stats_m_);
      stats_.frames++;
      stats_.skipped++;
      if (prev_frame_100ns_) stats_.gap.Add(static_cast<double>(stamp - prev_frame_100ns_) / 10'000.0);
      prev_frame_100ns_ = stamp;
      return;
    }
    prev_kept_100ns_ = stamp;

    auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    winrt::com_ptr<ID3D11Texture2D> texture;
    if (SUCCEEDED(access->GetInterface(winrt::guid_of<ID3D11Texture2D>(), texture.put_void()))) {
      D3D11_TEXTURE2D_DESC desc{};
      texture->GetDesc(&desc);
      if (ToneMap(texture.get(), static_cast<int32_t>(desc.Width), static_cast<int32_t>(desc.Height), size.Width,
                  size.Height)) {
        const size_t row = static_cast<size_t>(size.Width) * 4;
        // Allocated BEFORE the map: a bad_alloc here is survivable, the same throw between Map and
        // Unmap would leave the staging texture mapped for the life of the session and every later
        // frame failing, silently and forever.
        std::vector<uint8_t> pixels(row * static_cast<size_t>(size.Height));
        D3D11_MAPPED_SUBRESOURCE mapped{};
        if (SUCCEEDED(ctx_->Map(staging_.get(), 0, D3D11_MAP_READ, 0, &mapped))) {
          const auto unmap = ScopeExit([&] { ctx_->Unmap(staging_.get(), 0); });
          // Map() is the synchronisation point: it returns only once the GPU has finished the draw
          // and the copy, so everything above is included in this one number.
          const auto t1 = clock::now();
          gpu_ms = elapsed(t0, t1);
          // Row by row: the staging texture's pitch is driver-chosen and wider than the image.
          for (int32_t y = 0; y < size.Height; ++y) {
            memcpy(pixels.data() + row * static_cast<size_t>(y),
                   static_cast<const uint8_t*>(mapped.pData) + mapped.RowPitch * static_cast<size_t>(y), row);
          }
          copy_ms = elapsed(t1, clock::now());
          frame_w = size.Width;
          frame_h = size.Height;
          ok = true;
          napi_threadsafe_function sink = sink_.load(std::memory_order_acquire);
          if (sink) {
            if (!first_frame_100ns_) first_frame_100ns_ = stamp;
            auto* payload = new FramePayload{std::move(pixels), frame_w, frame_h,
                                             (stamp - first_frame_100ns_) / 10};  // 100ns -> µs
            // Non-blocking: a full queue means JS is behind, and the right answer there is to drop
            // this frame, not to stall the compositor's thread waiting for it.
            // Returns napi_closing rather than crashing once the environment is going away, which
            // is the only reason a stale pointer here is survivable.
            if (napi_call_threadsafe_function(sink, payload, napi_tsfn_nonblocking) != napi_ok) {
              delete payload;
              std::lock_guard<std::mutex> lock(stats_m_);
              stats_.dropped++;
            }
          } else {
            std::lock_guard<std::mutex> lock(stats_m_);
            frame_ = std::move(pixels);
            frame_w_ = frame_w;
            frame_h_ = frame_h;
          }
        }
      }
    }
  } catch (...) {
    // Includes bad_alloc, and RO_E_CLOSED from a pool torn down between dispatch and here.
    ok = false;
  }

  if (resized) {
    // A resolution change invalidates every buffer in the pool. Only record it as done if it was:
    // a failed Recreate leaves the capture on the old size, and counting it would hide that.
    try {
      pool.Recreate(rt_device_, wgdx::DirectXPixelFormat::R16G16B16A16Float, 2, size);
      content_w_ = size.Width;
      content_h_ = size.Height;
    } catch (winrt::hresult_error const&) {
      resized = false;
    }
  }

  std::lock_guard<std::mutex> lock(stats_m_);
  stats_.frames++;
  if (!ok) stats_.failed++;
  if (prev_frame_100ns_) stats_.gap.Add(static_cast<double>(stamp - prev_frame_100ns_) / 10'000.0);
  prev_frame_100ns_ = stamp;
  if (ok) {
    stats_.gpu.Add(gpu_ms);
    stats_.copy.Add(copy_ms);
    stats_.width = frame_w;
    stats_.height = frame_h;
  }
  if (resized) stats_.recreated++;
}

/** Resolve the display this session is on, right now. JS thread only — see the members. */
CaptureSession::DisplayState CaptureSession::CurrentDisplay() const {
  DisplayState out;
  std::wstring device = monitor_device_;
  if (window_) {
    // A minimised window has a rect at -32000, so MONITOR_DEFAULTTONEAREST would confidently name
    // the primary display and swing the divisor onto the wrong screen. TONULL plus the flag lets
    // the caller keep the last good value instead.
    out.minimized = IsIconic(window_) != FALSE;
    HMONITOR mon = MonitorFromWindow(window_, MONITOR_DEFAULTTONULL);
    if (!mon) return out;
    MONITORINFOEXW info{};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(mon, &info)) return out;
    device = info.szDevice;
  }
  if (device.empty()) return out;
  const auto white = SdrWhiteNits(device);
  out.sdr_white_measured = white.has_value();
  out.sdr_white_nits = white.value_or(80.0f);
  return out;
}

bool CaptureSession::UploadParams() {
  if (!ctx_ || !params_) return false;
  D3D11_MAPPED_SUBRESOURCE mapped{};
  if (FAILED(ctx_->Map(params_.get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped))) return false;
  memcpy(mapped.pData, &params_cpu_, sizeof(params_cpu_));
  ctx_->Unmap(params_.get(), 0);
  return true;
}

std::vector<uint8_t> CaptureSession::TakeFrame(int32_t* w, int32_t* h) {
  std::lock_guard<std::mutex> lock(stats_m_);
  *w = frame_w_;
  *h = frame_h_;
  // Moved, not copied: this used to hand back a 14 MB copy while holding the lock the capture
  // thread needs, so polling the frame actively slowed the cadence being measured.
  return std::move(frame_);
}

void CaptureSession::Stop(bool drop_device) {
  // Revoke FIRST and WITHOUT the lock. Revoking stops new dispatches; it does not join a handler
  // already running, so the lock below is what actually waits for one — and taking the lock before
  // revoking could deadlock against a handler queued behind it.
  if (pool_ && frame_token_) pool_.FrameArrived(frame_token_);
  if (item_ && closed_token_) item_.Closed(closed_token_);
  frame_token_ = {};
  closed_token_ = {};
  std::lock_guard<std::mutex> pipeline(pipeline_m_);
  if (napi_threadsafe_function sink = sink_.exchange(nullptr)) {
    // After the lock, so no OnFrame can still be holding it: releasing a threadsafe function that a
    // producer thread is about to call is how you get a callback into a destroyed environment.
    napi_release_threadsafe_function(sink, napi_tsfn_release);
  }
  first_frame_100ns_ = 0;
  if (session_) session_.Close();
  if (pool_) pool_.Close();
  session_ = nullptr;
  pool_ = nullptr;
  item_ = nullptr;
  // NOT cached: measured at 0.0 ms in all four rounds of tools/start-cost.cjs, so keeping it would
  // hold a WinRT reference alive to save nothing.
  rt_device_ = nullptr;
  rtv_ = nullptr;
  target_ = nullptr;
  staging_ = nullptr;
  target_w_ = target_h_ = 0;
  content_w_ = content_h_ = 0;
  prev_frame_100ns_ = 0;
  prev_kept_100ns_ = 0;
  // Reset too: the cap lives on a process-global session, and inheriting the last one's rate
  // would silently throttle the next capture. Same for a tone-map change nobody consumed.
  min_interval_100ns_.store(0, std::memory_order_relaxed);
  want_sdr_white_.store(0.0f, std::memory_order_relaxed);
  window_ = nullptr;
  monitor_device_.clear();
  // The device and everything hanging off it that does NOT depend on the target survive a stop —
  // that is the whole point (D3D11CreateDevice alone is ~96 ms of a ~148 ms start, EVERY start, and
  // a source switch pays it as black screen mid-call). `target_`/`staging_` are deliberately NOT
  // among them: ~28 MB at 1440p held for a restart that may never come, and they are rebuilt on the
  // WGC thread, so they cost the renderer nothing anyway.
  //
  // `drop_device` is for the two paths where keeping it is wrong: a start that FAILED (a dead device
  // must not be cached into every future start) and process teardown (see StopCaptureForTeardown —
  // releasing D3D from the static destructor during CRT shutdown is what that exists to avoid).
  // Assigned rather than left alone: `com_ptr::put()` asserts only in debug and leaks in release, so
  // a rebuild over a non-empty pointer would leak a whole D3D11 device per occurrence.
  if (drop_device) {
    vs_ = nullptr;
    ps_ = nullptr;
    sampler_ = nullptr;
    params_ = nullptr;
    ctx_ = nullptr;
    d3d_ = nullptr;
  }
  std::lock_guard<std::mutex> lock(stats_m_);
  stats_ = {};
  frame_.clear();
  frame_w_ = frame_h_ = 0;
}

CaptureStats CaptureSession::Snapshot() {
  std::lock_guard<std::mutex> lock(stats_m_);
  return stats_;
}

// ponytail: one session at a time. Sharing two displays at once is not a thing the UI can even ask
// for — the picker returns a single source.
CaptureSession g_capture;

/** The HMONITOR whose Windows device name (`\\.\DISPLAY1`) matches, or null. Same identifier
 *  QueryDisplays above reports, so JS can pass back whatever listDisplays gave it. */
HMONITOR MonitorByDeviceName(const std::wstring& name) {
  struct Search {
    const std::wstring& name;
    HMONITOR found;
  } search{name, nullptr};
  EnumDisplayMonitors(
      nullptr, nullptr,
      [](HMONITOR mon, HDC, LPRECT, LPARAM param) -> BOOL {
        auto* s = reinterpret_cast<Search*>(param);
        MONITORINFOEXW info{};
        info.cbSize = sizeof(info);
        if (GetMonitorInfoW(mon, &info) && s->name == info.szDevice) {
          s->found = mon;
          return FALSE;
        }
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&search));
  return search.found;
}

/**
 * The frame buffer handed to JS, REUSED across frames.
 *
 * Measured: allocating a fresh one per frame is 14.7 MB of garbage at 1440p, ~880 MB/s at 60 fps.
 * The resulting GC pauses were long enough to miss the threadsafe function's one-slot queue, which
 * showed up as 11.6% of frames dropped at the addon while the JS thread looked idle.
 *
 * Safe only because the subscriber copies synchronously: `new VideoFrame(buffer, …)` copies, and
 * the preload does it inside the callback. **A subscriber that keeps the ArrayBuffer past the
 * callback will watch it change under them.** Documented on the JS side too.
 */
napi_ref g_frame_buffer = nullptr;
size_t g_frame_buffer_size = 0;

napi_value FrameBuffer(napi_env env, size_t size) {
  if (g_frame_buffer && g_frame_buffer_size == size) {
    napi_value existing = nullptr;
    bool detached = false;
    if (napi_get_reference_value(env, g_frame_buffer, &existing) == napi_ok && existing &&
        napi_is_detached_arraybuffer(env, existing, &detached) == napi_ok && !detached) {
      return existing;
    }
    // Detached — someone transferred it. Reusing it would hand back a zero-length buffer on every
    // frame from now on: the memcpy below is skipped, the object is still delivered, `frames` keeps
    // climbing, `dropped` stays at 0, and the viewer watches black. Recreate instead.
  }
  if (g_frame_buffer) {
    napi_delete_reference(env, g_frame_buffer);
    g_frame_buffer = nullptr;
  }
  napi_value buffer;
  void* unused = nullptr;
  if (napi_create_arraybuffer(env, size, &unused, &buffer) != napi_ok) return nullptr;
  napi_create_reference(env, buffer, 1, &g_frame_buffer);
  g_frame_buffer_size = size;
  return buffer;
}

/** Runs on the JS thread, once per frame. Hands the pixels over and frees the payload. */
void DeliverFrame(napi_env env, napi_value callback, void*, void* data) {
  std::unique_ptr<FramePayload> payload(static_cast<FramePayload*>(data));
  // env is null when the environment is tearing down: free the payload, call nothing.
  if (!env || !callback) return;
  napi_value obj, width, height, timestamp;
  napi_create_object(env, &obj);
  napi_create_int32(env, payload->width, &width);
  napi_create_int32(env, payload->height, &height);
  napi_create_int64(env, payload->timestamp_us, &timestamp);
  napi_value buffer = FrameBuffer(env, payload->pixels.size());
  void* out = nullptr;
  size_t len = 0;
  if (buffer) napi_get_arraybuffer_info(env, buffer, &out, &len);
  // Delivering an object whose `data` is empty or stale is the worst outcome available: every
  // counter stays green and the picture is black. Count it and deliver nothing.
  if (!buffer || !out || len != payload->pixels.size() || payload->pixels.empty()) {
    g_capture.CountBufferFailure();
    return;
  }
  memcpy(out, payload->pixels.data(), payload->pixels.size());
  napi_set_named_property(env, obj, "width", width);
  napi_set_named_property(env, obj, "height", height);
  napi_set_named_property(env, obj, "timestampUs", timestamp);
  napi_set_named_property(env, obj, "data", buffer);
  napi_value global, unused;
  napi_get_global(env, &global);
  // Result ignored, exception swallowed: a throw in the subscriber must not kill the capture.
  if (napi_call_function(env, global, callback, 1, &obj, &unused) == napi_pending_exception) {
    napi_value err;
    napi_get_and_clear_last_exception(env, &err);
  }
}

napi_value StartCapture(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  size_t len = 0;
  if (argc < 1 || napi_get_value_string_utf16(env, argv[0], nullptr, 0, &len) != napi_ok) {
    napi_throw_type_error(env, nullptr, "startCapture(deviceName, sdrWhiteNits) expects a string");
    return nullptr;
  }
  // Sized to len+1 for the terminator napi writes, then trimmed: writing to data()[size()] is
  // formally UB, and the resize round trip costs nothing.
  std::wstring name(len + 1, L'\0');
  napi_get_value_string_utf16(env, argv[0], reinterpret_cast<char16_t*>(name.data()), len + 1, &len);
  name.resize(len);

  HMONITOR monitor = MonitorByDeviceName(name);
  if (!monitor) {
    napi_throw_error(env, nullptr, "no monitor with that device name");
    return nullptr;
  }
  // Optional: the shader falls back to the scRGB definition (80 nits).
  double sdr_white = 0;
  if (argc > 1) napi_get_value_double(env, argv[1], &sdr_white);

  // Optional 4th argument: a function to push frames to. Without it the session only records the
  // last frame for takeFrame(), which is what the measurement harness uses.
  napi_threadsafe_function sink = nullptr;
  napi_valuetype type = napi_undefined;
  if (argc > 2) napi_typeof(env, argv[2], &type);
  if (type == napi_function) {
    napi_value name;
    napi_create_string_utf8(env, "streamshare_frames", NAPI_AUTO_LENGTH, &name);
    // Queue of ONE, and that is measured rather than assumed: depths of 1, 2 and 3 all dropped the
    // same 9.7-9.9%, because the drops were never a queueing problem — they were a burst while the
    // page set up its peer connection (37 in the first second, then 0 over the next six). Reusing
    // the frame buffer later removed even that burst, so the current figure is 0 throughout. A
    // deeper queue would only have bought latency for a case that never existed.
    // Non-blocking at the call site, so the property is: never a backlog. (Not "newest wins" — a
    // full queue rejects the ARRIVING frame, not the queued one.)
    if (napi_create_threadsafe_function(env, argv[2], nullptr, name, 1, 1, nullptr,
                                        [](napi_env, void*, void*) { g_capture.ForgetSink(); }, nullptr, DeliverFrame,
                                        &sink) != napi_ok) {
      napi_throw_error(env, nullptr, "could not create the frame callback");
      return nullptr;
    }
  }

  // Optional fps cap. Type-checked rather than counted, and applied only AFTER a successful Start.
  // Both halves were bugs: `argc` is always the declared maximum (JS fills missing arguments with
  // undefined rather than omitting them), so an `argc >` guard is always true and left fps at 0;
  // and applying it before Start meant a second startCapture that then failed with "capture already
  // running" had already changed the cadence of the session it failed to replace.
  double fps = 0;
  napi_valuetype fps_type = napi_undefined;
  if (argc > 3) napi_typeof(env, argv[3], &fps_type);
  if (fps_type == napi_number) napi_get_value_double(env, argv[3], &fps);

  std::string err;
  if (!g_capture.Start(monitor, static_cast<float>(sdr_white), sink, &err)) {
    napi_throw_error(env, nullptr, err.c_str());  // Start already released the sink
    return nullptr;
  }
  g_capture.SetFps(fps);
  return nullptr;
}

/** The latest tone-mapped frame as BGRA8, plus its size — and it CONSUMES it, so a second call
 *  before the next frame returns an empty buffer. For the measurement harness; the streaming path
 *  will be pushed frames, not poll for them. */
napi_value TakeFrame(napi_env env, napi_callback_info) {
  int32_t w = 0, h = 0;
  // Moved out of the session, so nothing is copied while the capture thread's lock is held. The one
  // copy left is into the ArrayBuffer: napi_create_external_arraybuffer would remove it, but
  // Electron refuses external buffers (it returns napi_no_external_buffers_allowed), and a silent
  // fallback to an empty buffer is how this was found.
  const std::vector<uint8_t> pixels = g_capture.TakeFrame(&w, &h);
  napi_value obj, width, height, data;
  napi_create_object(env, &obj);
  napi_create_int32(env, w, &width);
  napi_create_int32(env, h, &height);
  void* out = nullptr;
  napi_create_arraybuffer(env, pixels.size(), &out, &data);
  if (out && !pixels.empty()) memcpy(out, pixels.data(), pixels.size());
  napi_set_named_property(env, obj, "width", width);
  napi_set_named_property(env, obj, "height", height);
  napi_set_named_property(env, obj, "data", data);
  return obj;
}

void ReleaseFrameBuffer(napi_env env);  // defined below, next to the buffer it frees

/** setFps(fps) — 0 for uncapped. Takes effect on the next frame. */
napi_value SetFps(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double fps = 0;
  if (argc > 0) napi_get_value_double(env, argv[0], &fps);
  g_capture.SetFps(fps);
  return nullptr;
}

/** setSdrWhite(nits) — the tone map's divisor. Takes effect on the next frame; a value that is not
 *  a positive finite number is ignored rather than clamped (see CaptureSession::SetSdrWhite). */
napi_value SetSdrWhite(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double nits = 0;
  if (argc > 0) napi_get_value_double(env, argv[0], &nits);
  g_capture.SetSdrWhite(nits);
  return nullptr;
}

/** startCaptureWindow(hwnd, sdrWhiteNits, onFrame, fps) — the window counterpart of startCapture.
 *  Neither carries a consent gate of its own: main decides what may be captured and the preload
 *  only ever passes what it was handed (see approvedTargetFor). */
/** displayForWindow(hwnd) -> the Windows device name of the display the window sits on, or null.
 *  A NAME rather than the whole display record: the caller already has the list from listDisplays,
 *  and resolving one window must not cost a full DisplayConfig walk per tile when the picker opens.
 *  Null for a minimised window — its rect is off-screen and any answer would be a guess. */
napi_value DisplayForWindow(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  int64_t handle = 0;
  napi_value null_value;
  napi_get_null(env, &null_value);
  // A real null, not a bare nullptr: N-API turns that into UNDEFINED, and both the docblock and the
  // TypeScript signature promise null. It only worked because the caller coalesced it away.
  if (argc < 1 || napi_get_value_int64(env, argv[0], &handle) != napi_ok || handle <= 0) return null_value;
  HWND window = reinterpret_cast<HWND>(static_cast<intptr_t>(handle));
  if (!IsWindow(window) || IsIconic(window)) return null_value;
  HMONITOR mon = MonitorFromWindow(window, MONITOR_DEFAULTTONULL);
  if (!mon) return null_value;
  MONITORINFOEXW mi{};
  mi.cbSize = sizeof(mi);
  if (!GetMonitorInfoW(mon, &mi)) return null_value;
  const std::wstring device(mi.szDevice);
  napi_value out;
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(device.c_str()), device.size(), &out);
  return out;
}

/** windowPid(hwnd) -> the owning process id, or null. The consent gate stores this next to the
 *  handle: Windows recycles HWNDs, and a handle alone cannot tell the window the user picked from
 *  whatever inherited its number after it closed. */
napi_value WindowPid(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  int64_t handle = 0;
  napi_value null_value;
  napi_get_null(env, &null_value);
  if (argc < 1 || napi_get_value_int64(env, argv[0], &handle) != napi_ok || handle <= 0) return null_value;
  HWND window = reinterpret_cast<HWND>(static_cast<intptr_t>(handle));
  if (!IsWindow(window)) return null_value;
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (!pid) return null_value;
  napi_value out;
  napi_create_double(env, static_cast<double>(pid), &out);
  return out;
}

napi_value StartCaptureWindow(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  int64_t handle = 0;
  if (argc < 1 || napi_get_value_int64(env, argv[0], &handle) != napi_ok || handle <= 0) {
    napi_throw_type_error(env, nullptr, "startCaptureWindow(hwnd, sdrWhiteNits) expects a window handle");
    return nullptr;
  }
  HWND window = reinterpret_cast<HWND>(static_cast<intptr_t>(handle));
  if (!IsWindow(window)) {
    napi_throw_error(env, nullptr, "no such window");
    return nullptr;
  }
  double sdr_white = 0;
  if (argc > 1) napi_get_value_double(env, argv[1], &sdr_white);
  napi_threadsafe_function sink = nullptr;
  napi_valuetype type = napi_undefined;
  if (argc > 2) napi_typeof(env, argv[2], &type);
  if (type == napi_function) {
    napi_value name;
    napi_create_string_utf8(env, "streamshare_frames", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, argv[2], nullptr, name, 1, 1, nullptr,
                                        [](napi_env, void*, void*) { g_capture.ForgetSink(); }, nullptr, DeliverFrame,
                                        &sink) != napi_ok) {
      napi_throw_error(env, nullptr, "could not create the frame callback");
      return nullptr;
    }
  }
  double fps = 0;
  napi_valuetype fps_type = napi_undefined;
  if (argc > 3) napi_typeof(env, argv[3], &fps_type);
  if (fps_type == napi_number) napi_get_value_double(env, argv[3], &fps);
  std::string err;
  if (!g_capture.StartWindow(window, static_cast<float>(sdr_white), sink, &err)) {
    napi_throw_error(env, nullptr, err.c_str());
    return nullptr;
  }
  g_capture.SetFps(fps);
  return nullptr;
}

napi_value StopCapture(napi_env env, napi_callback_info) {
  g_capture.Stop();
  // The reused frame buffer is up to 33 MB at 4K and was otherwise pinned for the life of the
  // window, long after the capture it belonged to.
  ReleaseFrameBuffer(env);
  return nullptr;
}

/**
 * Build the device and the pipeline WITHOUT starting a capture, so the next start finds them
 * cached. Everything expensive about a start that does not depend on the target: measured at ~96 ms
 * for D3D11CreateDevice plus ~5 for the two HLSL compilations, out of a ~148 ms cold start.
 *
 * Two callers, both off a click. The PRELOAD calls it when the picker opens, from an idle callback:
 * the host has signalled intent, the picker stays up while they read the tiles, and the block lands
 * there rather than on "share". MAIN calls it just after first paint, because its instance is a
 * separate process and would otherwise pay the same cost on the first tone-mapped thumbnail. Best effort in every sense: no error is surfaced, because the only consequence
 * of failing is that the start pays what it pays today.
 */
napi_value WarmUpCapture(napi_env, napi_callback_info) {
  g_capture.WarmUp();
  return nullptr;
}

void StopCaptureForTeardown() { g_capture.Stop(/*drop_device=*/true); }

/** Called from the env cleanup hook: the reused frame buffer must not outlive the environment that
 *  owns it, and it is the one thing here that is not tied to a running session. */
void ReleaseFrameBuffer(napi_env env) {
  if (!g_frame_buffer) return;
  napi_delete_reference(env, g_frame_buffer);
  g_frame_buffer = nullptr;
  g_frame_buffer_size = 0;
}

napi_value GetCaptureStats(napi_env env, napi_callback_info) {
  const CaptureStats s = g_capture.Snapshot();
  napi_value obj;
  napi_create_object(env, &obj);
  auto num = [&](const char* key, double value) {
    napi_value v;
    napi_create_double(env, value, &v);
    napi_set_named_property(env, obj, key, v);
  };
  auto tally = [&](const char* prefix, const Tally& t) {
    const std::string p(prefix);
    num((p + "AvgMs").c_str(), t.avg());
    num((p + "MaxMs").c_str(), t.max);
  };
  auto flag = [&](const char* key, bool value) {
    napi_value v;
    napi_get_boolean(env, value, &v);
    napi_set_named_property(env, obj, key, v);
  };
  num("frames", static_cast<double>(s.frames));
  num("failed", static_cast<double>(s.failed));
  num("empty", static_cast<double>(s.empty));
  num("dropped", static_cast<double>(s.dropped));
  num("undelivered", static_cast<double>(s.undelivered));
  num("skipped", static_cast<double>(s.skipped));
  flag("closed", s.closed);
  num("recreated", static_cast<double>(s.recreated));
  num("width", s.width);
  num("height", s.height);
  tally("gap", s.gap);
  tally("gpu", s.gpu);
  tally("copy", s.copy);
  napi_value running;
  napi_get_boolean(env, g_capture.running(), &running);
  napi_set_named_property(env, obj, "running", running);
  const auto up = g_capture.Startup();
  num("startupApartmentMs", up.apartment);
  num("startupSupportedMs", up.supported);
  num("startupDeviceMs", up.device);
  num("startupCompileVsMs", up.compileVs);
  num("startupCompilePsMs", up.compilePs);
  num("startupPipelineRestMs", up.pipelineRest);
  num("startupBufferMs", up.buffer);
  num("startupRtDeviceMs", up.rtDevice);
  num("startupItemMs", up.item);
  num("startupPoolMs", up.pool);
  num("startupSessionMs", up.session);
  num("startupTotalMs", up.total);
  // Live display state, resolved here on the JS thread. The page polls this at 10 Hz and owns the
  // divisor (reported white x the host's correction), so a window dragged to another screen — or
  // the Windows SDR brightness slider moving under a share — is picked up within ~100 ms (POLL_MS).
  const auto display = g_capture.CurrentDisplay();
  num("displaySdrWhiteNits", display.sdr_white_nits);
  flag("displaySdrWhiteMeasured", display.sdr_white_measured);
  // A minimised window produces NO frames and does NOT report itself closed (measured). Without
  // this flag the page cannot tell it apart from a dead capture, and would end the share.
  flag("minimized", display.minimized);
  return obj;
}

}  // namespace
#else
namespace {
// This file IS compiled on macOS and Linux. (An earlier comment here and in binding.gyp claimed the
// opposite: a `"sources": []` inside a gyp condition APPENDS to the list, it does not replace it —
// excluding would need `sources!`.) So these stubs are the real non-Windows behaviour: the addon
// loads, reports no displays, and src/lib falls back to getDisplayMedia. That is what we want; it
// is just not what "not built at all" would have given us.
napi_value ListDisplays(napi_env env, napi_callback_info) {
  napi_value arr;
  napi_create_array_with_length(env, 0, &arr);
  return arr;
}
napi_value StartCapture(napi_env env, napi_callback_info) {
  napi_throw_error(env, nullptr, "native capture is Windows-only");
  return nullptr;
}
napi_value StopCapture(napi_env, napi_callback_info) { return nullptr; }
napi_value WarmUpCapture(napi_env, napi_callback_info) { return nullptr; }
napi_value StartCaptureWindow(napi_env, napi_callback_info) { return nullptr; }
napi_value SetFps(napi_env, napi_callback_info) { return nullptr; }
napi_value SetSdrWhite(napi_env, napi_callback_info) { return nullptr; }
napi_value GetCaptureStats(napi_env env, napi_callback_info) {
  napi_value obj, running;
  napi_create_object(env, &obj);
  napi_get_boolean(env, false, &running);
  napi_set_named_property(env, obj, "running", running);
  return obj;
}
napi_value DisplayForWindow(napi_env, napi_callback_info) { return nullptr; }
napi_value WindowPid(napi_env, napi_callback_info) { return nullptr; }
napi_value TakeFrame(napi_env env, napi_callback_info) {
  napi_value obj;
  napi_create_object(env, &obj);
  return obj;
}
void StopCaptureForTeardown() {}
void ReleaseFrameBuffer(napi_env) {}
}  // namespace
#endif

namespace {

napi_value Init(napi_env env, napi_value exports) {
  for (const auto& [name, cb] : {std::pair<const char*, napi_callback>{"listDisplays", ListDisplays},
                                 {"startCapture", StartCapture},
                                 {"startCaptureWindow", StartCaptureWindow},
                                 {"displayForWindow", DisplayForWindow},
                                 {"windowPid", WindowPid},
                                 {"stopCapture", StopCapture},
                                 {"warmUpCapture", WarmUpCapture},
                                 {"setFps", SetFps},
                                 {"setSdrWhite", SetSdrWhite},
                                 {"captureStats", GetCaptureStats},
                                 {"takeFrame", TakeFrame}}) {
    napi_value fn;
    napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, nullptr, &fn);
    napi_set_named_property(env, exports, name, fn);
  }
  // Without this, closing the window or reloading the renderer leaves a capture running against a
  // dead environment, and the static destructor tears the D3D device down at process exit while a
  // WGC thread may still be inside the handler. Nobody remembers to call stopCapture().
  napi_add_env_cleanup_hook(
      env, [](void* e) { StopCaptureForTeardown(); ReleaseFrameBuffer(static_cast<napi_env>(e)); }, env);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
