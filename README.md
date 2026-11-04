# DTX Web Player

**Live: <https://syncopatch.github.io/dtx-web-player/>** — works on desktop and
iPad (installable as a Home-Screen app). Deploys automatically on push to
`main`; bump `VERSION` in `sw.js` when shell files change so installed PWAs
pick up the update.

A browser-based DTX chart player inspired by [DTXmaniaNX](https://github.com/limyz/DTXmaniaNX).
Drum mode only, autoplay only — it parses `.dtx` charts, plays the keysounds/BGM
with sample-accurate Web Audio scheduling, and renders a DTXMania-style falling-notes
lane view. No gameplay judgement or scoring.

No build step and no package manager — plain ES modules. Two third-party
libraries are vendored unmodified under `js/vendor/` and loaded only when
needed: an OGG decoder for Safari and [alphaTab](https://github.com/CoderLine/alphaTab)
(MPL-2.0) for reading Guitar Pro files.

## Running

Serve the folder over HTTP (ES modules don't load from `file://`):

```sh
cd DTXPlayerWeb
python3 serve.py        # http://localhost:8000 (port as optional argument)
```

`serve.py` is a stock `http.server` that additionally disables caching, so
updates appear on plain reload. `python3 -m http.server 8000` also works, but
browsers may cache files — hard-reload (Cmd+Shift+R) after updating.

## Usage

- **Import ZIP / GP** — pick one or more `.zip` files, each containing `.dtx` chart(s)
  and their audio files (subfolders are fine; Shift-JIS file names are handled).
  The same button accepts **Guitar Pro** files (`.gp`, `.gp3`, `.gp4`, `.gp5`,
  `.gpx`): each drum track becomes a chart, with repeats and D.S./coda jumps
  played out in order, voiced by a built-in synthesized drum kit.
- **Recording** (Settings, with a Guitar Pro chart open) — attach an audio file
  of the song (OGG / MP3 / WAV / M4A…); it is stored with the song and plays as
  the chart's BGM. The drum kit is muted by default once a recording is
  attached (toggle "Play drum kit"). **Shift chart** (100 ms steps) and
  **Fine shift** (5 ms) move the chart against the recording; a recording
  with an intro gets empty lead-in measures, so measure numbers then count
  those too. Unlike the display offsets, the shift re-times the chart itself,
  so the tab strip, loops and kit sounds follow it.
- **Auto-align** (same section) — analyses the recording in a Web Worker and
  finds where every measure falls, following tempo drift (a few seconds for a
  typical song). It finds the intro length and overall tempo, then tracks the
  measures one by one against kick / snare / cymbal onsets; a click-tracked
  recording gets a steady tempo. A confidence figure and any uncertain
  measures are shown. If it looks wrong, press **P** (or "Pin") at a few
  downbeats while the recording plays: the nearest measure is pinned there
  (tapping a little late is fine) and the chart re-aligns. **Reset** returns
  to the score's own tempo. The shift steppers still nudge the result.
- **Import URL** — download and import a ZIP directly from a URL. The hosting
  server must allow cross-origin requests (CORS); if it doesn't, download the
  file and use Import ZIP instead.
- **Import Folder** — same, but from an unzipped song folder.
- Imported songs are stored in the browser (IndexedDB), so they persist across
  visits on the same device. Delete them per-song from the list.
- Click a difficulty chip to play. Controls: play/pause (Space), restart, seek;
  Esc returns to the song list.

### Playback options (persisted per browser)

All settings live in a **Settings** panel available from both the library
screen and the player screen; the player's bottom bar keeps quick controls.
Scroll and play speed are adjusted with −/+ steppers (hold to repeat).

- **Scroll** (0.25x–10x, 0.25 steps) — visual note-scroll speed.
- **Play speed** (0.25x–2x, 0.05 steps) — actual playback tempo with **pitch-preserving
  time stretch**: the chart and audio slow down together while the on-screen
  scroll velocity stays the same, so notes spread out instead of crawling.
  Long sounds (BGM) are WSOLA time-stretched in a Web Worker; short drum
  keysounds simply trigger later and play unmodified, so their pitch and
  transients are untouched. Applied when the slider is released (stretching a
  full-length BGM takes a moment — there's a progress overlay; rapid stepper
  clicks are debounced so only the final value is stretched).
- **Display offset** — shifts the notes relative to the audio to compensate
  for audio output latency (±1000 ms, 5 ms steps; positive = notes hit the
  line later). A **chart offset** can be added on top for the currently open
  chart and is remembered per chart.
- **Notes / BGM / Master volume** — drum-note keysounds and BGM/auto-played
  sounds (BGM track, SE channels, hidden chips) have independent volume buses.
- **Tab strip** — the "Tab" button cycles Off → Bottom → Top, showing drum
  sheet notation (inspired by
  [drum-game](https://github.com/Jumprocks1/drum-game)) as a strip above or
  below the scrolling lanes, both synchronized to the same playhead: a
  five-line staff with standard kit mapping (kick bottom space, snare third
  space, x-heads for cymbals/hi-hat, ring for open hi-hat), hands beamed
  upward and feet downward with automatic 8th/16th beaming, and noteheads
  colored per note type.
- **Tab navigation** — a "Tab zoom" stepper (0.25x–4x, also Ctrl+wheel or
  pinch over the strip) controls how many measures fit on screen. While
  paused, the mouse wheel scrolls the strip to browse the chart, and a single
  click seeks to that measure (recentering the view). Measure spacing is
  independent of play speed, so notation keeps its width when practicing
  slow.
- **Practice loop** — while paused, click and drag across the strip to paint
  a measure-snapped loop; dragging past either edge auto-scrolls so long
  ranges are easy. Drag a loop edge (grips shown) to resize it, including
  past the opposite edge. Click inside the region (or the loop badge) to
  temporarily disable the loop — it turns grey and playback passes through —
  and click again to re-enable. Clear it with the ✕ on the badge. Playback
  cycles the looped measures, restarting mid-BGM correctly.
- **PDF export** — the "PDF" button engraves the open chart as printable
  black-on-white drum sheet music (A4 portrait, multi-page, self-contained —
  the PDF is generated in the browser with no libraries). Print-grade
  auto-formatting: flams become grace notes, triplets/quintuplets/etc. get
  tuplet numbers on their beams, basic rests (whole-measure, empty-beat, and
  leading 8th/16th rests), density-aware measure packing, percussion clef and
  time signatures, and notes padded off the barlines. Japanese titles are
  rasterized so they print correctly.
- **Lane display** (in the Settings panel):
  - *Lane order*: rearrange the 10 lanes arbitrarily with ▲/▼.
  - *Grouping*: DTXMania-style merge checkboxes — LC→HH (HH group),
    LP→BD (BD group), FT→LT (FT group), RD→CY (CY group). With all four on
    you get the classic 6-lane DrumMania layout. Grouped-in chips keep their
    own color and draw slightly inset on the target lane.
  - *Note colors*: a color picker for each of the 12 note types (LC, closed
    and open hi-hat, LP, LBD, SD, HT, BD, LT, FT, CY, RD).
  - *Hide lanes*: a per-lane "show" checkbox — hidden lanes disappear from the
    chart (their sounds still play).
  - *Display options* (DTXMania-style): Dark mode (OFF / HALF hides lane
    frames / FULL shows chips only), bar lines, beat lines, measure numbers,
    hit line, lane hit flash, lane opacity ("Lane Trans"), reverse scroll,
    and Sudden / Hidden note reveal modes.
  - Changes apply live during playback; "Reset to defaults" restores
    everything.
  - *Skin*: import a DTXMania / DTXManiaNX skin ZIP (any archive containing a
    `Graphics` folder with `7_chips_drums.png` etc.) and the play screen uses
    its artwork — note chips (animated), lane panels, hit bar, background,
    lane flashes, hit explosions and drum pads — drawn into this app's
    responsive lane layout, so lane reorder/grouping/hiding still work.
    Elements missing from a partial skin fall back to the built-in flat
    drawing; "None (default flat style)" restores it entirely. Skins are
    stored in the browser like songs (only the gameplay images are kept,
    ~1–3 MB).

## What's supported

- DTX headers: `#TITLE #ARTIST #BPM #DLEVEL #WAVxx #VOLUMExx/#WAVVOLxx #PANxx #BPMxx`
- Channels: BGM (`01`), bar length (`02`, persists to later measures), BPM changes
  (`03` direct and `08` extended), visible drum chips (`11`–`1C`), hidden chips
  (`31`–`3C`, sound only), auto SE (`61`–`92`)
- `SET.def` for song title and difficulty labels
- Guitar Pro 3–8 drum tracks (read with the vendored alphaTab importer). General
  MIDI drum sounds map to the lanes: kick → BD; snare, side stick and clap → SD;
  closed / open / pedal hi-hat → HH / open HH / LP; high, mid/low and floor toms →
  HT / LT / FT; crash, china and splash → CY; crash 2 → LC; ride and ride bell → RD.
  Each imported chart is generated as a regular `.dtx`, so every player feature
  (tab strip, loop, play speed, PDF and chart image export) works on it.
- Shift-JIS / UTF-8 / UTF-16 chart encodings; Shift-JIS ZIP entry names
- Hi-hat choke (close/open/pedal cut each other off), same-WAV retrigger cutoff
- WAV references resolve with alternate audio extensions (a chart saying `.wav`
  or `.xa` will find a shipped `.ogg`, like DTXMania does)

## Limitations

- Audio: OGG / WAV / MP3 / XA (and usually FLAC/M4A). On Safari/iPad, OGG is
  decoded by a vendored WASM decoder (`js/vendor/stbvorbis.js`). BandJAM XA
  (`.xa`) is decoded by `js/xa.js`, written from the format documented by
  [bjxa](https://sr.ht/~dridi/bjxa/). `.wma` keysounds are skipped with a
  warning.
- On iPad: tap the tab strip to seek, drag to browse, press-and-hold then
  drag to paint a practice loop, pinch to zoom the notation.
- No BGA / AVI, no MIDI, no judgement or scoring. Skins only reskin the play
  screen (no song-select/result art, gauge, combo or system sounds).
- Password-protected ZIPs are not supported.
- Guitar Pro: only drum tracks are imported (guitar and bass parts are
  ignored), and only from the file picker (not from ZIPs or URLs). Hand
  percussion with no drum lane (tambourine, cowbell, congas, …) is skipped with
  a warning; both bass-drum pedals land on BD; ghost-note dynamics are not
  kept. The synthesized kit is a preview sound, not a realistic kit.
- Auto-align expects the recording to follow the tab's structure: a live
  version with extra or missing sections won't line up (pins help only
  locally), and tempos more than about 20% off the tab need pins. Dense or
  heavily compressed mixes give less certain results.
- Needs a modern browser (uses `DecompressionStream`; Chrome 103+, Edge, Firefox 113+, Safari 16.4+).
