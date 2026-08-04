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

#ifdef _WIN32
#include <windows.h>
#include <dxgi1_6.h>
#include <string>
#include <vector>

namespace {

struct DisplayHdr {
  std::wstring device_name;  // \\.\DISPLAY1 — what EnumDisplayDevices reports
  bool hdr;
  // Reference white for SDR content while HDR is on, in nits. This is the value a tone map has to
  // aim at, and Windows lets the user move it with the SDR brightness slider — so it cannot be
  // hardcoded to 80 or 200 the way most samples do. Still a placeholder here.
  float sdr_white_nits;
  float max_luminance_nits;
  // Desktop rectangle in PHYSICAL pixels. Electron never exposes the Windows device name of a
  // Display, so this rect is the only thing the two sides share: it is what lets the renderer say
  // "the screen the user picked is the HDR one" instead of "some screen is HDR".
  int32_t left, top, right, bottom;
};

template <typename T>
struct ComPtr {
  T* p = nullptr;
  ~ComPtr() { if (p) p->Release(); }
  T** operator&() { return &p; }
  T* operator->() const { return p; }
  explicit operator bool() const { return p != nullptr; }
};

std::vector<DisplayHdr> QueryDisplays() {
  std::vector<DisplayHdr> out;
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory)))) return out;

  for (UINT a = 0;; ++a) {
    ComPtr<IDXGIAdapter1> adapter;
    if (factory->EnumAdapters1(a, &adapter) == DXGI_ERROR_NOT_FOUND) break;
    for (UINT o = 0;; ++o) {
      ComPtr<IDXGIOutput> output;
      if (adapter->EnumOutputs(o, &output) == DXGI_ERROR_NOT_FOUND) break;
      // IDXGIOutput6 is where GetDesc1 lives (Windows 10 1703+). An older interface simply means
      // no HDR information available, which we report as "not HDR" rather than as an error.
      ComPtr<IDXGIOutput6> output6;
      if (FAILED(output.p->QueryInterface(__uuidof(IDXGIOutput6), reinterpret_cast<void**>(&output6)))) continue;
      DXGI_OUTPUT_DESC1 desc{};
      if (FAILED(output6->GetDesc1(&desc))) continue;

      DisplayHdr d{};
      d.device_name = desc.DeviceName;
      // G2084 = the PQ transfer function with BT.2020 primaries: the compositor is in HDR mode.
      // Anything else (including scRGB float on an SDR desktop) is not what we are looking for.
      d.hdr = desc.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
      d.max_luminance_nits = desc.MaxLuminance;
      d.sdr_white_nits = 80.0f;  // TODO: DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL
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
    napi_value obj, name, hdr, sdr_white, max_lum;
    napi_create_object(env, &obj);
    napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(d.device_name.c_str()), d.device_name.size(), &name);
    napi_get_boolean(env, d.hdr, &hdr);
    napi_create_double(env, d.sdr_white_nits, &sdr_white);
    napi_create_double(env, d.max_luminance_nits, &max_lum);
    napi_set_named_property(env, obj, "deviceName", name);
    napi_set_named_property(env, obj, "hdr", hdr);
    napi_set_named_property(env, obj, "sdrWhiteNits", sdr_white);
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

}  // namespace
#else
namespace {
// Non-Windows builds are not produced at all (see binding.gyp), but keeping the symbol defined
// means a stray build fails loudly at link time rather than at runtime in someone's session.
napi_value ListDisplays(napi_env env, napi_callback_info) {
  napi_value arr;
  napi_create_array_with_length(env, 0, &arr);
  return arr;
}
}  // namespace
#endif

namespace {

napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "listDisplays", NAPI_AUTO_LENGTH, ListDisplays, nullptr, &fn);
  napi_set_named_property(env, exports, "listDisplays", fn);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
