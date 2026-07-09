// DTX chart parser (drum charts, DTXMania dialect).
//
// Produces header metadata, WAV definitions, and a fully timed chip list
// (absolute seconds computed from #BPM, channel 03/08 BPM changes, and
// channel 02 bar-length changes, which persist for subsequent measures).

// Sounding channels:
//   0x01        BGM
//   0x11..0x1C  visible drum chips (also sound)
//   0x31..0x3C  hidden drum chips (sound only)
//   0x61..0x92  SE01..SE50 auto-play sounds
export const DRUM_CH_MIN = 0x11;
export const DRUM_CH_MAX = 0x1C;

function isSoundChannel(ch) {
  return ch === 0x01 ||
    (ch >= 0x11 && ch <= 0x1C) ||
    (ch >= 0x31 && ch <= 0x3C) ||
    (ch >= 0x61 && ch <= 0x92);
}

// Decode DTX text: BOM-sniff for UTF-8/UTF-16, otherwise assume Shift-JIS.
export function decodeText(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  try { return new TextDecoder('shift_jis', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

function b36(str) {
  const v = parseInt(str, 36);
  return Number.isNaN(v) ? 0 : v;
}

// Parse a DTX file. With { headersOnly: true } the timeline is skipped
// (used when importing, to read titles/levels quickly).
export function parseDTX(text, { headersOnly = false } = {}) {
  const dtx = {
    title: '', artist: '', comment: '', genre: '',
    bpm: 120, level: null, preview: null, preimage: null,
    wavs: new Map(),    // wavId -> { file, volume (0-100), pan (-100..100) }
    chips: [],          // { time, ch, wav, visible } sorted by time
    bars: [],           // { time, num } measure starts
    beats: [],          // { time } beat lines (excluding measure starts)
    chartEnd: 0,        // time of the last chip (excluding audio tails)
  };

  const bpmDefs = new Map();   // xx -> bpm (#BPMxx)
  const barLens = new Map();   // measure -> length ratio (channel 02)
  const objects = [];          // { measure, ch, data }

  for (const raw of text.split(/\r\n|\n|\r/)) {
    let line = raw.trim();
    if (!line.startsWith('#')) continue;
    const sc = line.indexOf(';');
    if (sc >= 0) line = line.slice(0, sc).trimEnd();

    const m = line.match(/^#\s*([0-9A-Za-z]+)\s*:?\s*(.*)$/);
    if (!m) continue;
    const cmd = m[1].toUpperCase();
    const val = m[2].trim();

    // Object line: 3 decimal digits (measure) + 2 hex digits (channel).
    const om = cmd.match(/^(\d{3})([0-9A-F]{2})$/);
    if (om) {
      const measure = parseInt(om[1], 10);
      const ch = parseInt(om[2], 16);
      if (ch === 0x02) {
        const ratio = parseFloat(val);
        if (ratio > 0) barLens.set(measure, ratio);
      } else if (!headersOnly) {
        const data = val.replace(/[\s_]/g, '');
        if (data.length >= 2) objects.push({ measure, ch, data });
      }
      continue;
    }

    let hm;
    if (cmd === 'TITLE') dtx.title = val;
    else if (cmd === 'ARTIST') dtx.artist = val;
    else if (cmd === 'COMMENT') dtx.comment = val;
    else if (cmd === 'GENRE') dtx.genre = val;
    else if (cmd === 'PREVIEW') dtx.preview = val;
    else if (cmd === 'PREIMAGE') dtx.preimage = val;
    else if (cmd === 'BPM') { const b = parseFloat(val); if (b > 0) dtx.bpm = b; }
    else if (cmd === 'DLEVEL' || cmd === 'PLAYLEVEL') { const l = parseFloat(val); if (!Number.isNaN(l)) dtx.level = l; }
    else if ((hm = cmd.match(/^BPM([0-9A-Z]{2})$/))) { const b = parseFloat(val); if (b > 0) bpmDefs.set(b36(hm[1]), b); }
    else if ((hm = cmd.match(/^WAV([0-9A-Z]{2})$/))) {
      const id = b36(hm[1]);
      const w = dtx.wavs.get(id) || { file: '', volume: 100, pan: 0 };
      w.file = val;
      dtx.wavs.set(id, w);
    }
    else if ((hm = cmd.match(/^(?:VOLUME|WAVVOL)([0-9A-Z]{2})$/))) {
      const id = b36(hm[1]);
      const w = dtx.wavs.get(id) || { file: '', volume: 100, pan: 0 };
      const v = parseInt(val, 10);
      if (!Number.isNaN(v)) w.volume = Math.max(0, Math.min(100, v));
      dtx.wavs.set(id, w);
    }
    else if ((hm = cmd.match(/^(?:PAN|WAVPAN)([0-9A-Z]{2})$/))) {
      const id = b36(hm[1]);
      const w = dtx.wavs.get(id) || { file: '', volume: 100, pan: 0 };
      const v = parseInt(val, 10);
      if (!Number.isNaN(v)) w.pan = Math.max(-100, Math.min(100, v));
      dtx.wavs.set(id, w);
    }
    // Everything else (BGA/AVI/STAGEFILE/etc.) is ignored.
  }

  if (headersOnly) return dtx;

  // --- Build the timeline ---

  let maxMeasure = 0;
  for (const o of objects) maxMeasure = Math.max(maxMeasure, o.measure);
  for (const m of barLens.keys()) maxMeasure = Math.max(maxMeasure, m);
  maxMeasure += 1; // one trailing empty measure for the final bar line

  // Channel 02 changes the bar length from that measure onward.
  const barBeats = new Array(maxMeasure + 1);
  const beatStart = new Array(maxMeasure + 1);
  let ratio = 1.0, acc = 0;
  for (let m = 0; m <= maxMeasure; m++) {
    if (barLens.has(m)) ratio = barLens.get(m);
    barBeats[m] = 4 * ratio;
    beatStart[m] = acc;
    acc += barBeats[m];
  }

  // Expand object data into beat-positioned events.
  // kind: 0 = BPM change, 1 = bar line, 2 = beat line, 3 = chip
  // (BPM applies first on ties).
  const events = [];
  for (let m = 0; m <= maxMeasure; m++) {
    events.push({ beat: beatStart[m], kind: 1, num: m });
    for (let b = 1; b < barBeats[m] - 1e-9; b++) {
      events.push({ beat: beatStart[m] + b, kind: 2 });
    }
  }

  for (const o of objects) {
    const n = Math.floor(o.data.length / 2);
    for (let i = 0; i < n; i++) {
      const v = b36(o.data.slice(i * 2, i * 2 + 2));
      if (v === 0) continue;
      const beat = beatStart[o.measure] + (i / n) * barBeats[o.measure];
      if (o.ch === 0x03) {
        events.push({ beat, kind: 0, bpm: v }); // direct BPM value (base-36 int)
      } else if (o.ch === 0x08) {
        const bpm = bpmDefs.get(v);
        if (bpm) events.push({ beat, kind: 0, bpm });
      } else if (isSoundChannel(o.ch)) {
        events.push({ beat, kind: 3, ch: o.ch, wav: v });
      }
    }
  }

  events.sort((a, b) => (a.beat - b.beat) || (a.kind - b.kind));

  let time = 0, lastBeat = 0, bpm = dtx.bpm > 0 ? dtx.bpm : 120;
  for (const e of events) {
    time += (e.beat - lastBeat) * (60 / bpm);
    lastBeat = e.beat;
    if (e.kind === 0) {
      bpm = e.bpm;
    } else if (e.kind === 1) {
      dtx.bars.push({ time, num: e.num });
    } else if (e.kind === 2) {
      dtx.beats.push({ time });
    } else {
      const visible = e.ch >= DRUM_CH_MIN && e.ch <= DRUM_CH_MAX;
      dtx.chips.push({ time, ch: e.ch, wav: e.wav, visible });
      if (time > dtx.chartEnd) dtx.chartEnd = time;
    }
  }

  return dtx;
}

// Parse a SET.def file: returns { title, charts: [{ label, file }] }.
export function parseSetDef(text) {
  const res = { title: null, charts: [] };
  const byIndex = new Map();
  for (const raw of text.split(/\r\n|\n|\r/)) {
    let line = raw.trim();
    if (!line.startsWith('#')) continue;
    const sc = line.indexOf(';');
    if (sc >= 0) line = line.slice(0, sc).trimEnd();
    const m = line.match(/^#\s*([A-Za-z0-9]+)\s*:?\s*(.*)$/);
    if (!m) continue;
    const cmd = m[1].toUpperCase();
    const val = m[2].trim();
    let lm;
    if (cmd === 'TITLE') res.title = val;
    else if ((lm = cmd.match(/^L(\d+)LABEL$/))) {
      const e = byIndex.get(lm[1]) || {};
      e.label = val;
      byIndex.set(lm[1], e);
    } else if ((lm = cmd.match(/^L(\d+)FILE$/))) {
      const e = byIndex.get(lm[1]) || {};
      e.file = val;
      byIndex.set(lm[1], e);
    }
  }
  for (const [, e] of [...byIndex.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (e.file) res.charts.push({ label: e.label || '', file: e.file });
  }
  return res;
}
