# onnxruntime-web (vendored)

Copied **unmodified** from the npm package
[`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) version
**1.29.0** (`dist/`), with its MIT `LICENSE` (Copyright Microsoft Corporation).

- Source: <https://github.com/microsoft/onnxruntime>
- npm tarball integrity: `sha512-LuQlpX6MFLJZu756erwUeb1mNfoJGbs1kzDwJGNlf5RvfYMdqhcY3vNpDPK40CUV2HoWTkIj+uS0o36GFHjeYw==`
- `ort.webgpu.min.mjs` SHA-256: `08272eb8dadd249a0eaa53e19f4e5b5d01bc8a121240719db29093cfb776bc27`
- `ort-wasm-simd-threaded.asyncify.mjs` SHA-256: `5d25483158d53d8f34d0e9c06a654d56c8dca4ebdf370ea0982ef11315a00e0e`
- `ort-wasm-simd-threaded.asyncify.wasm` SHA-256: `503d17cb7411b79781b9fad1cf0978f03cf06b050c7d399c730e914f473bf549`

`ort.webgpu.min.mjs` is the ES-module entry (WebGPU and WASM execution
providers); it loads the `asyncify` runtime from this folder. Used by
`js/separate-worker.js` for in-browser drum separation, loaded only when
separating, and cached at runtime by `sw.js` (the wasm is too large to
precache with the shell).

To update: download the new tarball from the npm registry, verify its
`dist.integrity`, copy the three files and check which runtime files the new
`ort.webgpu.min.mjs` references, update the version and hashes above, and
update the cache name in `sw.js`.
