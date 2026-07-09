# DTX Web Player

A browser-based DTX chart player inspired by [DTXmaniaNX](https://github.com/limyz/DTXmaniaNX).
Drum mode only, autoplay only — it parses `.dtx` charts, plays the keysounds/BGM
with sample-accurate Web Audio scheduling, and renders a DTXMania-style falling-notes
lane view. No gameplay judgement or scoring.

No build step, no dependencies — plain ES modules.

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

- **Import ZIP** — pick one or more `.zip` files, each containing `.dtx` chart(s)
  and their audio files (subfolders are fine; Shift-JIS file names are handled).
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
- **Practice loop** — click a measure on the tab strip to loop it; click
  another measure to extend the loop across the range; click inside the loop
  to clear it (or use the ✕ on the loop badge). Playback cycles the looped
  measures, restarting mid-BGM correctly.
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

## What's supported

- DTX headers: `#TITLE #ARTIST #BPM #DLEVEL #WAVxx #VOLUMExx/#WAVVOLxx #PANxx #BPMxx`
- Channels: BGM (`01`), bar length (`02`, persists to later measures), BPM changes
  (`03` direct and `08` extended), visible drum chips (`11`–`1C`), hidden chips
  (`31`–`3C`, sound only), auto SE (`61`–`92`)
- `SET.def` for song title and difficulty labels
- Shift-JIS / UTF-8 / UTF-16 chart encodings; Shift-JIS ZIP entry names
- Hi-hat choke (close/open/pedal cut each other off), same-WAV retrigger cutoff
- WAV references resolve with alternate audio extensions (a chart saying `.wav`
  or `.xa` will find a shipped `.ogg`, like DTXMania does)

## Limitations

- Audio must be decodable by the browser: OGG / WAV / MP3 (and usually FLAC/M4A).
  `.xa` and `.wma` keysounds are skipped with a warning.
- No BGA / AVI / images, no MIDI, no judgement or scoring.
- Password-protected ZIPs are not supported.
- Needs a modern browser (uses `DecompressionStream`; Chrome 103+, Edge, Firefox 113+, Safari 16.4+).
