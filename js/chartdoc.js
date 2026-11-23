// Editable chart document for the editor, with an exact DTX round trip.
// Pure (no DOM), so it runs under `node --test`.
//
// A DTX file is kept as:
//   headers  every non-object line, verbatim and in order (comments, unknown
//            commands, #WAV / #BPM definitions…); edits append or replace
//            single lines, so a saved file differs only where it was edited
//   lens     effective length of each measure (channel 02 persists until it
//            changes, as DTXMania reads it)
//   events   every object of every channel as { m, ch, pos: {n, d}, val }:
//            pos is the exact fraction of the measure (any resolution, 7, 192,
//            384… round-trips), val the two-character value as written
//
// Operations return a new document (events are copied, never mutated), so the
// editor keeps snapshots for undo.

const LINE = /^#\s*([0-9A-Za-z]+)\s*:?\s*(.*)$/;

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}
const lcm = (a, b) => (a / gcd(a, b)) * b;

export function frac(n, d) {
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
export const fracValue = (p) => p.n / p.d;
export const fracEq = (a, b) => a.n * b.d === b.n * a.d;
export const fracCmp = (a, b) => a.n * b.d - b.n * a.d;

const b36 = (s) => {
  const v = parseInt(s, 36);
  return Number.isNaN(v) ? 0 : v;
};
export const base36 = (n) => n.toString(36).toUpperCase().padStart(2, '0');
const hex2 = (ch) => ch.toString(16).toUpperCase().padStart(2, '0');

// Strip a ';' comment, as the parser does.
function command(raw) {
  let line = raw.trim();
  if (!line.startsWith('#')) return null;
  const sc = line.indexOf(';');
  if (sc >= 0) line = line.slice(0, sc).trimEnd();
  const m = line.match(LINE);
  return m ? { cmd: m[1].toUpperCase(), val: m[2].trim() } : null;
}

const OBJECT = /^(\d{3})([0-9A-F]{2})$/;

export function fromDtx(text) {
  const headers = [];
  const events = [];
  const lenAt = new Map(); // measure -> written ratio
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const c = command(raw);
    const om = c?.cmd.match(OBJECT);
    if (!om) { headers.push(raw); continue; }
    const m = parseInt(om[1], 10);
    const ch = parseInt(om[2], 16);
    if (ch === 0x02) {
      const r = parseFloat(c.val);
      if (r > 0) lenAt.set(m, r);
      continue;
    }
    const data = c.val.replace(/[\s_]/g, '');
    const n = Math.floor(data.length / 2);
    for (let i = 0; i < n; i++) {
      const val = data.slice(i * 2, i * 2 + 2).toUpperCase();
      if (val === '00') continue;
      events.push({ m, ch, pos: frac(i, n), val });
    }
  }
  while (headers.length && !headers[headers.length - 1].trim()) headers.pop();
  let count = 0;
  for (const e of events) count = Math.max(count, e.m + 1);
  for (const m of lenAt.keys()) count = Math.max(count, m + 1);
  const lens = [];
  let r = 1;
  for (let m = 0; m < count; m++) {
    if (lenAt.has(m)) r = lenAt.get(m);
    lens.push(r);
  }
  return sortEvents({ kind: 'dtx', headers, lens, events });
}

function sortEvents(doc) {
  doc.events.sort((a, b) => a.m - b.m || fracCmp(a.pos, b.pos) || a.ch - b.ch);
  return doc;
}

// One object line's data for events of one measure and channel. Returns
// several lines' worth when two events share a position.
function objectLines(list) {
  const lines = [];
  let rest = list;
  while (rest.length) {
    const L = rest.reduce((a, e) => lcm(a, e.pos.d), 1);
    const slots = new Array(L).fill('00');
    const again = [];
    for (const e of rest) {
      const i = (e.pos.n * L) / e.pos.d;
      if (slots[i] !== '00') again.push(e);
      else slots[i] = e.val;
    }
    lines.push(slots.join(''));
    rest = again;
  }
  return lines;
}

const fmtLen = (r) => String(Math.round(r * 1e9) / 1e9);

export function toDtx(doc) {
  const out = [...doc.headers];
  if (out.length) out.push('');
  const byMeasure = new Map();
  for (const e of doc.events) {
    if (!byMeasure.has(e.m)) byMeasure.set(e.m, new Map());
    const chs = byMeasure.get(e.m);
    if (!chs.has(e.ch)) chs.set(e.ch, []);
    chs.get(e.ch).push(e);
  }
  let prev = 1;
  for (let m = 0; m < Math.max(doc.lens.length, ...[...byMeasure.keys()].map((k) => k + 1)); m++) {
    const len = doc.lens[m] ?? prev;
    const mm = String(m).padStart(3, '0');
    if (Math.abs(len - prev) > 1e-12) out.push(`#${mm}02: ${fmtLen(len)}`);
    prev = len;
    const chs = byMeasure.get(m);
    if (!chs) continue;
    for (const ch of [...chs.keys()].sort((a, b) => a - b)) {
      for (const data of objectLines(chs.get(ch))) out.push(`#${mm}${hex2(ch)}: ${data}`);
    }
  }
  return out.join('\r\n') + '\r\n';
}

// ---- headers ----

function headerIndex(doc, name) {
  return doc.headers.findIndex((raw) => command(raw)?.cmd === name);
}

export function getHeader(doc, name) {
  const i = headerIndex(doc, name);
  return i < 0 ? null : command(doc.headers[i]).val;
}

// Set (or with value null, remove) a header such as TITLE or WAV0A.
export function setHeader(doc, name, value) {
  const headers = [...doc.headers];
  const i = headerIndex(doc, name);
  if (value == null) { if (i >= 0) headers.splice(i, 1); }
  else if (i >= 0) headers[i] = `#${name}: ${value}`;
  else headers.push(`#${name}: ${value}`);
  return { ...doc, headers };
}

// #WAVxx definitions: Map(val 'XX' -> file).
export function wavList(doc) {
  const out = new Map();
  for (const raw of doc.headers) {
    const c = command(raw);
    const w = c?.cmd.match(/^WAV([0-9A-Z]{2})$/);
    if (w) out.set(w[1], c.val);
  }
  return out;
}

// Define a sound and return [doc, val] (reuses an existing definition).
export function addWav(doc, file) {
  const wavs = wavList(doc);
  for (const [val, f] of wavs) if (f.toLowerCase() === file.toLowerCase()) return [doc, val];
  for (let i = 1; i < 36 * 36; i++) {
    const val = base36(i);
    if (!wavs.has(val)) return [setHeader(doc, `WAV${val}`, file), val];
  }
  throw new Error('This chart already defines the maximum number of sounds (1295).');
}

// ---- timing ----

export const DRUM_CHANNELS = [0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C];
const isBpmCh = (ch) => ch === 0x03 || ch === 0x08;

export function measureCount(doc) {
  let n = doc.lens.length;
  for (const e of doc.events) n = Math.max(n, e.m + 1);
  return n;
}

export function lenOf(doc, m) {
  if (m < doc.lens.length) return doc.lens[m];
  return doc.lens.length ? doc.lens[doc.lens.length - 1] : 1;
}

// Beat (quarter-note) positions of measure starts, for `count` measures.
export function measureStarts(doc, count = measureCount(doc) + 1) {
  const starts = [0];
  for (let m = 0; m < count; m++) starts.push(starts[m] + 4 * lenOf(doc, m));
  return starts;
}

// Beat <-> seconds through the chart's tempo changes, as the parser times
// them (BPM changes apply at their beat).
export function timing(doc) {
  const starts = measureStarts(doc);
  const bpmDefs = new Map();
  for (const raw of doc.headers) {
    const c = command(raw);
    const b = c?.cmd.match(/^BPM([0-9A-Z]{2})$/);
    if (b) { const v = parseFloat(c.val); if (v > 0) bpmDefs.set(b36(b[1]), v); }
  }
  const base = parseFloat(getHeader(doc, 'BPM')) > 0 ? parseFloat(getHeader(doc, 'BPM')) : 120;
  const changes = [];
  for (const e of doc.events) {
    if (!isBpmCh(e.ch)) continue;
    const bpm = e.ch === 0x03 ? b36(e.val) : bpmDefs.get(b36(e.val));
    if (bpm > 0) changes.push({ beat: (starts[e.m] ?? 0) + fracValue(e.pos) * 4 * lenOf(doc, e.m), bpm });
  }
  changes.sort((a, b) => a.beat - b.beat);
  const segs = [{ beat: 0, time: 0, bpm: base }];
  for (const c of changes) {
    const last = segs[segs.length - 1];
    segs.push({ beat: c.beat, time: last.time + (c.beat - last.beat) * 60 / last.bpm, bpm: c.bpm });
  }
  const seg = (key, v) => {
    let i = 0;
    while (i + 1 < segs.length && segs[i + 1][key] <= v) i++;
    return segs[i];
  };
  return {
    starts,
    beatOf: (m, pos) => (starts[m] ?? starts[starts.length - 1]) + fracValue(pos) * 4 * lenOf(doc, m),
    timeOfBeat: (b) => { const s = seg('beat', b); return s.time + (b - s.beat) * 60 / s.bpm; },
    beatOfTime: (t) => { const s = seg('time', t); return s.beat + (t - s.time) * s.bpm / 60; },
    bpmAt: (b) => seg('beat', b).bpm,
  };
}

// ---- note editing ----

const same = (a, b) => a.m === b.m && a.ch === b.ch && fracEq(a.pos, b.pos);

export function addEvents(doc, list) {
  const events = doc.events.filter((e) => !list.some((n) => same(e, n)));
  return sortEvents({ ...doc, events: [...events, ...list.map((e) => ({ ...e, pos: frac(e.pos.n, e.pos.d) }))] });
}

export function removeEvents(doc, list) {
  return { ...doc, events: doc.events.filter((e) => !list.some((n) => same(e, n) && e.val === n.val)) };
}

// Replace events (same order) by changed copies: change(e) -> new event.
export function updateEvents(doc, list, change) {
  const keep = doc.events.filter((e) => !list.some((n) => same(e, n) && e.val === n.val));
  const moved = list.map((e) => {
    const n = change(e);
    return { ...n, pos: frac(n.pos.n, n.pos.d) };
  });
  const rest = keep.filter((e) => !moved.some((n) => same(e, n)));
  return sortEvents({ ...doc, events: [...rest, ...moved] });
}

// Move events by a number of beats (keeping each inside the chart), and/or
// to another channel. resolve(ch) maps a lane move; grid (per measure) snaps
// positions; returns null if any event would leave the chart.
export function shiftEvents(doc, list, beats, { mapCh = (ch) => ch, grid = 192 } = {}) {
  const t = timing(doc);
  const total = measureCount(doc);
  const placed = [];
  for (const e of list) {
    const b = t.beatOf(e.m, e.pos) + beats;
    const at = positionAt(doc, b, grid, total);
    if (!at) return null;
    placed.push({ ...e, m: at.m, pos: at.pos, ch: mapCh(e.ch) });
  }
  const keep = doc.events.filter((e) => !list.some((n) => same(e, n) && e.val === n.val));
  const rest = keep.filter((e) => !placed.some((n) => same(e, n)));
  return sortEvents({ ...doc, events: [...rest, ...placed] });
}

// The measure and fraction at a beat, snapped to `grid` steps per whole
// note (192 = DTXCreator's finest common grid). null outside the chart.
export function positionAt(doc, beat, grid = 192, total = measureCount(doc)) {
  const starts = measureStarts(doc, total);
  if (beat < -1e-9 || beat >= starts[total] - 1e-9) return null;
  let m = 0;
  while (m + 1 < total && starts[m + 1] <= beat + 1e-9) m++;
  const len = lenOf(doc, m);
  const steps = Math.max(1, Math.round(grid * len));
  let k = Math.round(((beat - starts[m]) / (4 * len)) * steps);
  if (k >= steps) { if (m + 1 >= total) k = steps - 1; else return { m: m + 1, pos: frac(0, 1) }; }
  return { m, pos: frac(k, steps) };
}

// The sound most used on a channel (for new notes), or null.
export function commonWav(doc, ch) {
  const counts = new Map();
  for (const e of doc.events) if (e.ch === ch) counts.set(e.val, (counts.get(e.val) || 0) + 1);
  let best = null, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

// Add empty measures at the end (lengths continue the last one).
export function extend(doc, count) {
  const lens = [...doc.lens];
  const last = lens.length ? lens[lens.length - 1] : 1;
  while (lens.length < count) lens.push(last);
  return { ...doc, lens };
}

// ---- structure: measures, lengths, tempo ----

// A decimal measure length as an exact fraction (0.875 -> 7/8), by
// continued fractions up to a denominator of maxDen.
export function toFrac(x, maxDen = 3840) {
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let v = x;
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(v);
    const [h2, k2] = [a * h1 + h0, a * k1 + k0];
    if (k2 > maxDen) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    if (Math.abs(v - a) < 1e-12 || Math.abs(h1 / k1 - x) < 1e-12) break;
    v = 1 / (v - a);
  }
  return frac(h1, k1);
}

const withLens = (doc, count) => (doc.lens.length >= count ? [...doc.lens] : extend(doc, count).lens);

// Insert `count` empty measures before measure `at`, as long as the measure
// that was there (or the last one). Later notes and tempo changes move with
// their measures.
export function insertMeasures(doc, at, count = 1) {
  const len = lenOf(doc, at);
  const lens = withLens(doc, at);
  lens.splice(at, 0, ...new Array(count).fill(len));
  const events = doc.events.map((e) => (e.m >= at ? { ...e, m: e.m + count } : e));
  return { ...doc, lens, events };
}

// Delete measures [at, at + count) with their notes. A tempo change inside
// them moves to the start of what follows, so later measures keep their tempo.
export function deleteMeasures(doc, at, count = 1) {
  const end = at + count;
  const lens = [...doc.lens];
  lens.splice(at, count);
  const gone = doc.events.filter((e) => e.m >= at && e.m < end);
  const events = doc.events.filter((e) => e.m < at || e.m >= end).map((e) => (e.m >= end ? { ...e, m: e.m - count } : e));
  const lastBpm = gone.filter((e) => isBpmCh(e.ch)).at(-1);
  const total = Math.max(lens.length, ...events.map((e) => e.m + 1), 0);
  if (lastBpm && at < total && !events.some((e) => isBpmCh(e.ch) && e.m === at && e.pos.n === 0)) {
    events.push({ ...lastBpm, m: at, pos: frac(0, 1) });
  }
  return sortEvents({ ...doc, lens, events });
}

// Events that a new length would cut off, for measures [from, to).
export function eventsPastLength(doc, from, to, len) {
  return doc.events.filter((e) => e.m >= from && e.m < to && fracValue(e.pos) * lenOf(doc, e.m) >= len - 1e-9);
}

// Give measures [from, to) a new length (in whole notes: 0.75 = 3/4).
// Notes keep their beat within the measure; ones past the new end are
// removed. Returns the new document.
export function setMeasureLength(doc, from, to, len) {
  const lens = withLens(doc, to);
  const nf = toFrac(len);
  const events = [];
  for (const e of doc.events) {
    if (e.m < from || e.m >= to) { events.push(e); continue; }
    const of = toFrac(lenOf(doc, e.m));
    const pos = frac(e.pos.n * of.n * nf.d, e.pos.d * of.d * nf.n);
    if (pos.n < pos.d) events.push({ ...e, pos });
  }
  for (let m = from; m < to; m++) lens[m] = len;
  return sortEvents({ ...doc, lens, events });
}

// The measure after `m` where the length changes (end of a run of equal
// lengths), at most the chart's end.
export function lengthRunEnd(doc, m) {
  const total = measureCount(doc);
  const len = lenOf(doc, m);
  let end = m + 1;
  while (end < total && Math.abs(lenOf(doc, end) - len) < 1e-12) end++;
  return Math.max(end, m + 1);
}

// Tempo change written at a position (channel 03 or 08), or null.
export function bpmEventAt(doc, m, pos) {
  return doc.events.find((e) => isBpmCh(e.ch) && e.m === m && fracEq(e.pos, pos)) || null;
}

const fmtBpm = (bpm) => String(Math.round(bpm * 1000) / 1000);

// Set the tempo from a position on. At the very start it is the #BPM header.
// Other positions use channel 08 with a #BPMxx definition (any value,
// decimals too), reusing a definition with the same value.
export function setBpm(doc, m, pos, bpm) {
  if (!(bpm > 0)) throw new Error('BPM must be above 0.');
  let out = removeBpm(doc, m, pos);
  if (m === 0 && pos.n === 0) return setHeader(out, 'BPM', fmtBpm(bpm));
  let id = null;
  const used = new Set();
  for (const raw of out.headers) {
    const c = command(raw);
    const b = c?.cmd.match(/^BPM([0-9A-Z]{2})$/);
    if (!b) continue;
    used.add(b[1]);
    if (!id && Math.abs(parseFloat(c.val) - bpm) < 1e-9) id = b[1];
  }
  if (!id) {
    for (let i = 1; i < 36 * 36 && !id; i++) if (!used.has(base36(i))) id = base36(i);
    if (!id) throw new Error('This chart already defines the maximum number of tempos (1295).');
    out = setHeader(out, `BPM${id}`, fmtBpm(bpm));
  }
  return addEvents(out, [{ m, ch: 0x08, pos, val: id }]);
}

export function removeBpm(doc, m, pos) {
  return { ...doc, events: doc.events.filter((e) => !(isBpmCh(e.ch) && e.m === m && fracEq(e.pos, pos))) };
}

// ---- sounds ----

// Channels whose values are #WAV sounds (as js/dtx.js plays them).
export const isSoundCh = (ch) => ch === 0x01 || (ch >= 0x11 && ch <= 0x1C) || (ch >= 0x31 && ch <= 0x3C) || (ch >= 0x61 && ch <= 0x92);

// How many objects use each sound: Map(val -> count).
export function wavUsage(doc) {
  const out = new Map();
  for (const e of doc.events) {
    if (!isSoundCh(e.ch)) continue;
    out.set(e.val, (out.get(e.val) || 0) + 1);
  }
  return out;
}

export function setEventsVal(doc, list, val) {
  return updateEvents(doc, list, (e) => ({ ...e, val }));
}
