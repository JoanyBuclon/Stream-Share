{
  "targets": [
    {
      "target_name": "streamshare_capture",
      "sources": ["src/addon.cc"],
      "defines": ["UNICODE", "_UNICODE"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": ["-ldxgi.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/std:c++20", "/EHsc"]
              }
            }
          },
          {
            # Everything here is Windows Graphics Capture and DXGI. On any other platform the addon
            # is not built at all — src/lib falls back to getDisplayMedia, which is what non-Windows
            # users already get today.
            "sources": []
          }
        ]
      ]
    }
  ]
}
