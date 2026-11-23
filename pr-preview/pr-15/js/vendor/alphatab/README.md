# alphaTab (vendored)

`alphaTab.core.min.mjs` is copied **unmodified** from the npm package
[`@coderline/alphatab`](https://www.npmjs.com/package/@coderline/alphatab)
version **1.9.0** (`dist/alphaTab.core.min.mjs`), with its `LICENSE`.

- Source: <https://github.com/CoderLine/alphaTab>
- License: MPL-2.0 (file-level copyleft). Keep this file unmodified; changes
  to it would have to be published under the MPL. The license header of the
  integrated libraries is preserved at the top of the module.
- npm tarball integrity: `sha512-pG/Um03DdiTW7i9KR+rPTRRnzIW5oJBWs67altBXtCkxGvUG1RuvkgRTZO3GIaOD2vATjcw+5OevMZl9I2/T+Q==`
- `alphaTab.core.min.mjs` SHA-256: `bc8aa20762f4802d19a09b9864ca5ef27e98ce2586a318f7c03a9f7b479c4934`

The app uses only its Guitar Pro importer and MIDI generator (see
`js/gp.js`), loaded lazily when a Guitar Pro file is imported. It does not use
alphaTab's renderer, so no alphaTab-rendered score is displayed.

To update: download the new tarball from the npm registry, verify its
`dist.integrity`, copy `dist/alphaTab.core.min.mjs` and `LICENSE` here, update
the version and hashes above, and bump `VERSION` in `sw.js`.
