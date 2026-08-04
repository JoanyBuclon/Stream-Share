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
            "libraries": ["-ldxgi.lib", "-ld3d11.lib", "-ld3dcompiler.lib", "-lwindowsapp.lib"],
            # C++/WinRT ships with the SDK but is NOT on node-gyp's default include path (only um,
            # shared, ucrt and winrt are). The MSBuild macros resolve to whatever SDK version the
            # generated project targets, so this does not pin a version.
            "include_dirs": ["$(WindowsSdkDir)Include/$(WindowsTargetPlatformVersion)/cppwinrt"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/std:c++20", "/EHsc", "/permissive-"]
              }
            }
          },
          {
            # Nothing to add off Windows. NOTE for whoever reads this as an exclusion: it is not
            # one. A list inside a gyp condition is APPENDED to the target's, never substituted —
            # excluding would need `"sources!"`. So src/addon.cc IS compiled on macOS and Linux,
            # and its non-Windows branch supplies no-op stubs. That is what we want: require()
            # succeeds, listDisplays returns [], and src/lib falls back to getDisplayMedia.
            "sources": []
          }
        ]
      ]
    }
  ]
}
