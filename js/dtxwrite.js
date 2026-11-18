// Serializes a beat-domain chart model to DTX text, so charts from other
// sources play through the normal parseDTX pipeline.
//
// model: {
//   title, artist,
//   division,                         // ticks per quarter note
//   bars: [{ ticks, notes: [{ tick, ch }] }],  // tick is relative to the bar
//   tempos: [{ bar, tick, bpm }],     // sorted; the first one is the start tempo
// }
// options.wavs: Map<channel, file> of the sound played by each drum channel.
// options.kitVolume: 0-100 volume of those sounds (default 100).
// options.bgm: { file, bar, tick } places a recording on the BGM channel.

const MAX_MEASURES = 1000;  // measure numbers are 3 decimal digits
const MAX_BPM_DEFS = 1295;  // #BPM01..#BPMZZ

function base36(n) {
  return n.toString(36).toUpperCase().padStart(2, '0');
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// The parser treats ';' as a comment and lines as records, so neither can
// appear in a header value.
function headerValue(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/;/g, '；').trim();
}

// One measure's events on one channel, on the smallest grid that holds them
// exactly. events: [{ tick, id }]
function objectData(events, barTicks) {
  let g = barTicks;
  for (const e of events) g = gcd(g, e.tick);
  const slots = new Array(barTicks / g).fill('00');
  for (const e of events) slots[e.tick / g] = base36(e.id);
  return slots.join('');
}

// Absolute quarter-note position of each bar start.
function barPositions(model) {
  const start = [];
  let q = 0;
  for (const b of model.bars) {
    start.push(q);
    q += b.ticks / model.division;
  }
  return { start, total: q };
}

// Rounds tempos to `decimals` places. Each segment's value is chosen from the
// exact target time of the segment's end, so rounding errors can't accumulate.
function roundTempos(model, tempos, start, total, decimals) {
  const scale = 10 ** decimals;
  const q = (t) => start[t.bar] + t.tick / model.division;
  const out = [];
  let exact = 0, written = 0;
  for (let i = 0; i < tempos.length; i++) {
    const beats = (i + 1 < tempos.length ? q(tempos[i + 1]) : total) - q(tempos[i]);
    exact += beats * 60 / tempos[i].bpm;
    let bpm = tempos[i].bpm;
    if (beats > 0 && exact > written) bpm = 60 * beats / (exact - written);
    bpm = Math.max(1 / scale, Math.round(bpm * scale) / scale);
    written += beats * 60 / bpm;
    out.push({ ...tempos[i], bpm });
  }
  return out;
}

export function writeDtx(model, tempoMap = model.tempos, { wavs = new Map(), kitVolume = 100, bgm = null } = {}) {
  if (!model.bars.length) throw new Error('This chart has no measures.');
  if (model.bars.length > MAX_MEASURES) {
    throw new Error(`This chart has ${model.bars.length} measures; DTX supports ${MAX_MEASURES}.`);
  }
  if (!tempoMap.length) throw new Error('This chart has no tempo.');
  const ticksOk = model.bars.every((b) => Number.isInteger(b.ticks) && b.ticks > 0 &&
    b.notes.every((n) => Number.isInteger(n.tick) && n.tick >= 0 && n.tick < b.ticks)) &&
    tempoMap.every((t) => Number.isInteger(t.tick) && t.tick >= 0 && t.tick < (model.bars[t.bar]?.ticks ?? 0));
  if (!ticksOk) throw new Error('Chart positions must be whole ticks inside their measure.');
  if (bgm && !(Number.isInteger(bgm.tick) && bgm.tick >= 0 && bgm.tick < (model.bars[bgm.bar]?.ticks ?? 0))) {
    throw new Error('The recording position must be a whole tick inside a measure.');
  }

  // Coarser rounding merges near-identical tempos, which keeps a densely
  // anchored chart within the #BPMxx limit.
  const { start, total } = barPositions(model);
  let tempos, bpmIds;
  for (const decimals of [3, 2, 1, 0]) {
    tempos = roundTempos(model, tempoMap, start, total, decimals);
    bpmIds = new Map();
    for (const t of tempos.slice(1)) {
      if (!bpmIds.has(t.bpm)) bpmIds.set(t.bpm, bpmIds.size + 1);
    }
    if (bpmIds.size <= MAX_BPM_DEFS) break;
  }
  if (bpmIds.size > MAX_BPM_DEFS) throw new Error('This chart has too many tempo changes for DTX.');

  const wavIds = new Map();
  for (const ch of wavs.keys()) wavIds.set(ch, wavIds.size + 1);
  const bgmId = wavIds.size + 1;
  const volume = Math.max(0, Math.min(100, Math.round(kitVolume)));

  const lines = [
    `#TITLE: ${headerValue(model.title)}`,
    `#ARTIST: ${headerValue(model.artist)}`,
    `#BPM: ${tempos[0].bpm}`,
    '',
  ];
  for (const [ch, file] of wavs) {
    const id = base36(wavIds.get(ch));
    lines.push(`#WAV${id}: ${headerValue(file)}`);
    if (volume !== 100) lines.push(`#VOLUME${id}: ${volume}`);
  }
  if (bgm) lines.push(`#WAV${base36(bgmId)}: ${headerValue(bgm.file)}`);
  for (const [bpm, id] of bpmIds) lines.push(`#BPM${base36(id)}: ${bpm}`);
  lines.push('');

  const measure = (m) => String(m).padStart(3, '0');
  const barTempos = new Map();
  for (const t of tempos.slice(1)) {
    if (!barTempos.has(t.bar)) barTempos.set(t.bar, []);
    barTempos.get(t.bar).push(t);
  }

  let ratio = 1;
  model.bars.forEach((bar, m) => {
    const barRatio = bar.ticks / (model.division * 4);
    // The last measure is always written: it may be empty, and the parser
    // only knows about measures that appear in the file.
    if (barRatio !== ratio || m === model.bars.length - 1) {
      lines.push(`#${measure(m)}02: ${barRatio}`);
      ratio = barRatio;
    }

    const here = barTempos.get(m);
    if (here) {
      const events = here.map((t) => ({ tick: t.tick, id: bpmIds.get(t.bpm) }));
      lines.push(`#${measure(m)}08: ${objectData(events, bar.ticks)}`);
    }

    if (bgm && bgm.bar === m) {
      lines.push(`#${measure(m)}01: ${objectData([{ tick: bgm.tick, id: bgmId }], bar.ticks)}`);
    }

    const byChannel = new Map();
    for (const n of bar.notes) {
      if (!wavIds.has(n.ch)) continue;
      if (!byChannel.has(n.ch)) byChannel.set(n.ch, []);
      byChannel.get(n.ch).push({ tick: n.tick, id: wavIds.get(n.ch) });
    }
    for (const [ch, events] of [...byChannel].sort((a, b) => a[0] - b[0])) {
      const hex = ch.toString(16).toUpperCase().padStart(2, '0');
      lines.push(`#${measure(m)}${hex}: ${objectData(events, bar.ticks)}`);
    }
  });

  return lines.join('\n') + '\n';
}
