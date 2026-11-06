// Per-hit keysounds from separated drum stems.
//
// Every drum chip of a chart synced to a recording knows where it falls in
// that recording (chip.time - bgmTime). The chip's keysound is the slice of
// its component stem from that hit up to the next hit on the same stem, so
// the chart re-plays the real drummer, hit by hit. Slices are recomputed from
// chip times whenever a chart loads, so they follow re-alignment and shifts.

// Chart lane -> stem, with fallbacks for splitters with fewer stems.
export const LANE_STEMS = new Map([
  [0x13, ['kick']], [0x1C, ['kick']],
  [0x12, ['snare']],
  [0x14, ['toms']], [0x15, ['toms']], [0x17, ['toms']],
  [0x11, ['hh', 'cymbals']], [0x18, ['hh', 'cymbals']], [0x1B, ['hh', 'cymbals']],
  [0x19, ['ride', 'cymbals', 'crash']],
  [0x16, ['crash', 'cymbals']], [0x1A, ['crash', 'cymbals']],
]);

export const STEM_NAMES = ['kick', 'snare', 'toms', 'hh', 'ride', 'crash', 'cymbals'];

const HOP_S = 0.005; // envelope hop
const SNAP_S = 0.025; // search radius around the charted time
const PRE_S = 0.003; // slice starts this much before the onset
const SAME_S = 0.012; // same-stem chips closer than this are one hit
export const MAX_SLICE_S = 4;

// Frame energies of a mono signal (cached per Float32Array).
const envCache = new WeakMap();
function envelope(data, sr) {
  let env = envCache.get(data);
  if (env) return env;
  const hop = Math.max(1, Math.round(HOP_S * sr));
  env = new Float32Array(Math.ceil(data.length / hop));
  for (let f = 0; f < env.length; f++) {
    let e = 0;
    for (let i = f * hop, end = Math.min(data.length, i + hop); i < end; i++) e += data[i] * data[i];
    env[f] = e;
  }
  envCache.set(data, env);
  return env;
}

// Onset near recording time t (seconds): the frame with the strongest energy
// rise within ±SNAP_S, or t itself when the stem is quiet there.
export function snapOnset(data, sr, t) {
  const env = envelope(data, sr);
  const hop = Math.max(1, Math.round(HOP_S * sr));
  const c = Math.round((t * sr) / hop);
  const r = Math.ceil(SNAP_S / HOP_S);
  let best = -1;
  let bestRise = 0;
  let peak = 0;
  for (let f = Math.max(1, c - r); f <= Math.min(env.length - 1, c + r); f++) {
    peak = Math.max(peak, env[f]);
    const rise = env[f] - env[f - 1];
    if (rise > bestRise) { bestRise = rise; best = f; }
  }
  // Ignore rises that are tiny next to the loudest frame nearby (bleed/noise).
  if (best < 0 || bestRise < 0.25 * peak || peak < 1e-7 * hop) return t;
  return ((best - 0.5) * hop) / sr; // the rise happens within the previous frame
}

// chips: parsed chart chips (time-sorted). stems: { name: { data: Float32Array, sr } }.
// Sets chip.slice = { stem, off, len } (seconds into the stem; len 0 = silent)
// on every drum chip whose lane has a stem. Returns the number of sliced chips.
export function assignSlices(chips, bgmTime, stems) {
  const byStem = new Map();
  for (const c of chips) {
    delete c.slice;
    const prefs = LANE_STEMS.get(c.ch);
    const stem = prefs?.find((s) => stems[s]);
    if (!stem) continue;
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(c);
  }
  let count = 0;
  for (const [stem, list] of byStem) {
    const { data, sr } = stems[stem];
    const dur = data.length / sr;
    // Onsets first, so each slice can end where the next hit starts.
    const hits = [];
    let prev = -Infinity;
    for (const c of list) {
      const r = c.time - bgmTime;
      if (r < 0 || r >= dur || r - prev < SAME_S) {
        c.slice = { stem, off: 0, len: 0 }; // before/after the recording, or a duplicate
        continue;
      }
      prev = r;
      const start = Math.max(0, snapOnset(data, sr, r) - PRE_S);
      // Two chips that snap onto the same onset are one hit (e.g. BD + LBD
      // charted a little apart); snapping also must not reorder hits.
      if (hits.length && start - hits[hits.length - 1].start < SAME_S) {
        c.slice = { stem, off: 0, len: 0 };
        continue;
      }
      hits.push({ c, start });
    }
    for (let i = 0; i < hits.length; i++) {
      const { c, start } = hits[i];
      const next = i + 1 < hits.length ? hits[i + 1].start : dur;
      const len = Math.max(0, Math.min(next, start + MAX_SLICE_S, dur) - start);
      c.slice = { stem, off: start, len };
      count++;
    }
  }
  return count;
}
