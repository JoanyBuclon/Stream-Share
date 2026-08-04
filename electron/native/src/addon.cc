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

#include <chrono>
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
  uint64_t empty = 0;  // FrameArrived with nothing behind it (pool closed mid-flight)
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
  bool Start(HMONITOR monitor, float sdr_white, float knee, std::string* err);
  void Stop();
  /** Live tone-map parameters. Cheap enough to call per keystroke from a settings slider. */
  void SetParams(float sdr_white, float knee);
  CaptureStats Snapshot();
  bool running() const { return session_ != nullptr; }
  /** Moved out, not copied: the caller gets the buffer and the session allocates a fresh one. */
  std::vector<uint8_t> TakeFrame(int32_t* w, int32_t* h);

 private:
  void OnFrame(wgc::Direct3D11CaptureFramePool const& pool, winrt::Windows::Foundation::IInspectable const&);
  bool BuildPipeline(std::string* err);
  bool EnsureTargets(int32_t width, int32_t height);
  bool ToneMap(ID3D11Texture2D* source, int32_t width, int32_t height, int32_t content_w, int32_t content_h);
  void UploadParams();  // caller holds pipeline_m_

  // --- GPU pipeline: touched only under pipeline_m_ ---
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
  std::vector<uint8_t> frame_;  // BGRA8, tightly packed
  int32_t frame_w_ = 0, frame_h_ = 0;
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
  if (!compile("VSMain", "vs_5_0", vs_blob) || !compile("PSMain", "ps_5_0", ps_blob)) return false;
  winrt::check_hresult(
      d3d_->CreateVertexShader(vs_blob->GetBufferPointer(), vs_blob->GetBufferSize(), nullptr, vs_.put()));
  winrt::check_hresult(
      d3d_->CreatePixelShader(ps_blob->GetBufferPointer(), ps_blob->GetBufferSize(), nullptr, ps_.put()));

  D3D11_SAMPLER_DESC sd{};
  sd.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;  // 1:1 blit, so no filtering to pay for
  sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
  winrt::check_hresult(d3d_->CreateSamplerState(&sd, sampler_.put()));
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

bool CaptureSession::Start(HMONITOR monitor, float sdr_white, float knee, std::string* err) {
  if (session_) {
    *err = "capture already running";
    return false;
  }
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
    if (!wgc::GraphicsCaptureSession::IsSupported()) {
      *err = "Windows Graphics Capture is not supported on this machine";
      return false;
    }
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    // ponytail: default adapter, not the one that owns the HMONITOR. On a hybrid or dual-GPU
    // machine that costs a cross-adapter copy per frame. Invisible on the single-GPU box this was
    // measured on; QueryDisplays already walks the adapters if it ever needs fixing.
    winrt::check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, nullptr, 0,
                                           D3D11_SDK_VERSION, d3d_.put(), nullptr, ctx_.put()));
    if (!BuildPipeline(err)) {
      Stop();
      return false;
    }
    // DYNAMIC, not IMMUTABLE: the SDR white level is a live value. Windows lets the user move its
    // slider mid-session, and our own settings modal will expose a knee. Baking it in would mean
    // tearing down the device and the capture session to change one float.
    D3D11_BUFFER_DESC bd{};
    bd.ByteWidth = sizeof(ShaderParams);
    bd.Usage = D3D11_USAGE_DYNAMIC;
    bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    bd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    const ShaderParams initial{sdr_white > 0 ? sdr_white : 80.0f, knee > 0 && knee < 1 ? knee : 0.75f, {1.0f, 1.0f}};
    D3D11_SUBRESOURCE_DATA init{&initial, 0, 0};
    winrt::check_hresult(d3d_->CreateBuffer(&bd, &init, params_.put()));
    params_cpu_ = initial;

    winrt::com_ptr<::IInspectable> inspectable;
    winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(d3d_.as<IDXGIDevice>().get(), inspectable.put()));
    rt_device_ = inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();

    auto interop = winrt::get_activation_factory<wgc::GraphicsCaptureItem, ::IGraphicsCaptureItemInterop>();
    winrt::check_hresult(
        interop->CreateForMonitor(monitor, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item_)));

    // R16G16B16A16Float is the whole point: it is scRGB, so HDR highlights arrive above 1.0 instead
    // of clamped the way getDisplayMedia's BGRA8 delivers them. Two buffers, because a deeper pool
    // only buys latency we are trying not to spend.
    pool_ = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(
        rt_device_, wgdx::DirectXPixelFormat::R16G16B16A16Float, 2, item_.Size());
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
      if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
              L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired")) {
        session_.IsBorderRequired(false);
      }
    } catch (winrt::hresult_error const&) {
    }
    session_.StartCapture();
    return true;
  } catch (winrt::hresult_error const& e) {
    *err = winrt::to_string(e.message());
    Stop();
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
  if (u != params_cpu_.uv_scale[0] || v != params_cpu_.uv_scale[1]) {
    params_cpu_.uv_scale[0] = u;
    params_cpu_.uv_scale[1] = v;
    UploadParams();
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
  if (!ctx_) return;  // Stop() ran while this dispatch was queued

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
          std::lock_guard<std::mutex> lock(stats_m_);
          frame_ = std::move(pixels);
          frame_w_ = frame_w;
          frame_h_ = frame_h;
          ok = true;
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

void CaptureSession::SetParams(float sdr_white, float knee) {
  std::lock_guard<std::mutex> pipeline(pipeline_m_);
  if (sdr_white > 0) params_cpu_.sdr_white = sdr_white;
  if (knee > 0 && knee < 1) params_cpu_.knee = knee;
  UploadParams();
}

void CaptureSession::UploadParams() {
  if (!ctx_ || !params_) return;
  D3D11_MAPPED_SUBRESOURCE mapped{};
  if (FAILED(ctx_->Map(params_.get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped))) return;
  memcpy(mapped.pData, &params_cpu_, sizeof(params_cpu_));
  ctx_->Unmap(params_.get(), 0);
}

std::vector<uint8_t> CaptureSession::TakeFrame(int32_t* w, int32_t* h) {
  std::lock_guard<std::mutex> lock(stats_m_);
  *w = frame_w_;
  *h = frame_h_;
  // Moved, not copied: this used to hand back a 14 MB copy while holding the lock the capture
  // thread needs, so polling the frame actively slowed the cadence being measured.
  return std::move(frame_);
}

void CaptureSession::Stop() {
  // Revoke FIRST and WITHOUT the lock. Revoking stops new dispatches; it does not join a handler
  // already running, so the lock below is what actually waits for one — and taking the lock before
  // revoking could deadlock against a handler queued behind it.
  if (pool_ && frame_token_) pool_.FrameArrived(frame_token_);
  if (item_ && closed_token_) item_.Closed(closed_token_);
  frame_token_ = {};
  closed_token_ = {};
  std::lock_guard<std::mutex> pipeline(pipeline_m_);
  if (session_) session_.Close();
  if (pool_) pool_.Close();
  session_ = nullptr;
  pool_ = nullptr;
  item_ = nullptr;
  rt_device_ = nullptr;
  vs_ = nullptr;
  ps_ = nullptr;
  sampler_ = nullptr;
  params_ = nullptr;
  rtv_ = nullptr;
  target_ = nullptr;
  staging_ = nullptr;
  target_w_ = target_h_ = 0;
  content_w_ = content_h_ = 0;
  prev_frame_100ns_ = 0;
  ctx_ = nullptr;
  d3d_ = nullptr;
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

napi_value StartCapture(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  size_t len = 0;
  if (argc < 1 || napi_get_value_string_utf16(env, argv[0], nullptr, 0, &len) != napi_ok) {
    napi_throw_type_error(env, nullptr, "startCapture(deviceName, sdrWhiteNits, knee) expects a string");
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
  // Both optional: the shader falls back to the scRGB definition (80 nits) and a 0.75 knee.
  double sdr_white = 0, knee = 0;
  if (argc > 1) napi_get_value_double(env, argv[1], &sdr_white);
  if (argc > 2) napi_get_value_double(env, argv[2], &knee);

  std::string err;
  if (!g_capture.Start(monitor, static_cast<float>(sdr_white), static_cast<float>(knee), &err)) {
    napi_throw_error(env, nullptr, err.c_str());
    return nullptr;
  }
  return nullptr;
}

/** Live tone-map parameters: setParams(sdrWhiteNits, knee). No restart. */
napi_value SetParams(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double sdr_white = 0, knee = 0;
  if (argc > 0) napi_get_value_double(env, argv[0], &sdr_white);
  if (argc > 1) napi_get_value_double(env, argv[1], &knee);
  g_capture.SetParams(static_cast<float>(sdr_white), static_cast<float>(knee));
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

napi_value StopCapture(napi_env env, napi_callback_info) {
  g_capture.Stop();
  return nullptr;
}

void StopCaptureForTeardown() { g_capture.Stop(); }

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
napi_value SetParams(napi_env, napi_callback_info) { return nullptr; }
napi_value GetCaptureStats(napi_env env, napi_callback_info) {
  napi_value obj, running;
  napi_create_object(env, &obj);
  napi_get_boolean(env, false, &running);
  napi_set_named_property(env, obj, "running", running);
  return obj;
}
napi_value TakeFrame(napi_env env, napi_callback_info) {
  napi_value obj;
  napi_create_object(env, &obj);
  return obj;
}
void StopCaptureForTeardown() {}
}  // namespace
#endif

namespace {

napi_value Init(napi_env env, napi_value exports) {
  for (const auto& [name, cb] : {std::pair<const char*, napi_callback>{"listDisplays", ListDisplays},
                                 {"startCapture", StartCapture},
                                 {"stopCapture", StopCapture},
                                 {"setParams", SetParams},
                                 {"captureStats", GetCaptureStats},
                                 {"takeFrame", TakeFrame}}) {
    napi_value fn;
    napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, nullptr, &fn);
    napi_set_named_property(env, exports, name, fn);
  }
  // Without this, closing the window or reloading the renderer leaves a capture running against a
  // dead environment, and the static destructor tears the D3D device down at process exit while a
  // WGC thread may still be inside the handler. Nobody remembers to call stopCapture().
  napi_add_env_cleanup_hook(env, [](void*) { StopCaptureForTeardown(); }, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
