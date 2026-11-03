// Timing a beat-domain chart model (see dtxwrite.js) to a recording.
//
// Everything is expressed as the audio time of every measure start:
// barTimes[b] is when measure b begins in the recording, and barTimes[B]
// (B = number of measures) is when the last one ends. A plain shift is the
// score's own timing plus a constant; an alignment supplies its own times.
// Inside a measure the score's tempo shape is kept and scaled to fit.

const EPS = 0.0005; // seconds; differences below this are treated as zero
const LEAD_GRID = 20; // lead-in partial measures snap to 1/48 quarter (at 960 PPQ)

// Tempo segments active in each measure: [[{ tick, bpm }]] per bar, the
// first segment of every bar starting at tick 0.
export function barSegments(model) {
  const tempos = [...model.tempos].sort((a, b) => a.bar - b.bar || a.tick - b.tick);
  const out = [];
  let i = 0, bpm = tempos[0]?.bpm || 120;
  for (let b = 0; b < model.bars.length; b++) {
    const segs = [];
    while (i < tempos.length && tempos[i].bar < b) bpm = tempos[i++].bpm;
    while (i < tempos.length && tempos[i].bar === b && tempos[i].tick === 0) bpm = tempos[i++].bpm;
    segs.push({ tick: 0, bpm });
    while (i < tempos.length && tempos[i].bar === b) {
      bpm = tempos[i].bpm;
      const last = segs[segs.length - 1];
      if (last.tick === tempos[i].tick) last.bpm = bpm;
      else segs.push({ tick: tempos[i].tick, bpm });
      i++;
    }
    out.push(segs);
  }
  return out;
}

function segmentSeconds(model, b, segs, scale = 1) {
  const ticks = model.bars[b].ticks;
  return segs.map((s, j) => {
    const end = j + 1 < segs.length ? segs[j + 1].tick : ticks;
    return ((end - s.tick) / model.division) * 60 / (s.bpm * scale);
  });
}

// Score time of every measure start, plus the end of the last one.
export function scoreBarTimes(model) {
  const segs = barSegments(model);
  const times = [0];
  for (let b = 0; b < model.bars.length; b++) {
    const d = segmentSeconds(model, b, segs[b]).reduce((a, x) => a + x, 0);
    times.push(times[b] + d);
  }
  return times;
}

// Audio times of measure starts for a song's sync state: an alignment's own
// times if present, else the score's timing, plus the manual shift.
export function barTimesForSync(model, sync = {}) {
  const base = sync.barTimes?.length === model.bars.length + 1 ? sync.barTimes : scoreBarTimes(model);
  const shift = (sync.shiftMs || 0) / 1000;
  return base.map((t) => t + shift);
}

// Builds the model to write so that measure b starts at barTimes[b] in the
// recording, with the recording placed as BGM.
// Returns { model, tempos, bgm: { bar, tick }, leadBars }.
export function buildTimedChart(model, barTimes) {
  const B = model.bars.length;
  if (barTimes.length !== B + 1) throw new Error('Need a time for every measure start and the end.');
  for (let b = 0; b < B; b++) {
    if (!(barTimes[b + 1] - barTimes[b] > EPS)) throw new Error(`Measure ${b + 1} would have no length.`);
  }

  const segs = barSegments(model);
  const scoreLen = segs.map((s, b) => segmentSeconds(model, b, s).reduce((a, x) => a + x, 0));
  const scales = scoreLen.map((len, b) => len / (barTimes[b + 1] - barTimes[b]));

  // Lead-in: empty measures before the first one, so the chart starts with
  // the recording. Sized at about the opening tempo; the tempo is then set
  // so they last exactly as long as needed.
  const start = barTimes[0];
  const lead = [];
  let leadBpm = 0;
  if (start > EPS) {
    const div = model.division;
    const first = model.bars[0].ticks;
    const quarters = start * segs[0][0].bpm * scales[0] / 60;
    const full = Math.floor(quarters / (first / div));
    let rest = Math.round(((quarters - full * (first / div)) * div) / LEAD_GRID) * LEAD_GRID;
    if (!full && !rest) rest = LEAD_GRID;
    if (rest) lead.push({ ticks: rest, notes: [] });
    for (let i = 0; i < full; i++) lead.push({ ticks: first, notes: [] });
    const total = lead.reduce((a, b) => a + b.ticks, 0) / div;
    leadBpm = 60 * total / start;
  }
  const L = lead.length;

  const tempos = [];
  const push = (t) => {
    const prev = tempos[tempos.length - 1];
    if (prev && Math.abs(prev.bpm - t.bpm) <= prev.bpm * 1e-9) return;
    tempos.push(t);
  };
  if (L) push({ bar: 0, tick: 0, bpm: leadBpm });
  for (let b = 0; b < B; b++) {
    for (const s of segs[b]) push({ bar: b + L, tick: s.tick, bpm: s.bpm * scales[b] });
  }

  // Where audio time 0 falls: the start of the chart, or (when the chart
  // begins before the recording) inside some measure.
  let bgm = { bar: 0, tick: 0 };
  if (start < -EPS) {
    const b = barTimes.findIndex((t, i) => i < B && t <= 0 && barTimes[i + 1] > 0);
    if (b < 0) throw new Error('The recording starts after the chart ends.');
    let left = -barTimes[b];
    const secs = segmentSeconds(model, b, segs[b], scales[b]);
    let tick = model.bars[b].ticks;
    for (let j = 0; j < segs[b].length; j++) {
      if (left <= secs[j] || j === segs[b].length - 1) {
        const perTick = 60 / (segs[b][j].bpm * scales[b]) / model.division;
        tick = segs[b][j].tick + Math.round(left / perTick);
        break;
      }
      left -= secs[j];
    }
    bgm = tick >= model.bars[b].ticks && b + 1 < B ? { bar: b + 1 + L, tick: 0 } : { bar: b + L, tick: Math.min(tick, model.bars[b].ticks - 1) };
  }

  return {
    model: { ...model, bars: lead.concat(model.bars), tempos },
    tempos,
    bgm,
    leadBars: L,
  };
}
