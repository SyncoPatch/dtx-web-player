// Foot assignment for beat-domain chart models (see dtxwrite.js).
//
// Guitar Pro drum tracks put every kick on one bass drum and only write a
// hi-hat pedal where the score asks for one. This pass makes the chart read
// like a hand-made DTX: fast kick runs alternate between both feet, and an
// open hi-hat gets a pedal note where the next closed hit shuts it.
//
// It returns a new model; the source model is never changed, so the result
// can be recomputed whenever options or edits change.

import { barSegments } from './gpsync.js';

export const CH_HHC = 0x11;
export const CH_BD = 0x13;
export const CH_HHO = 0x18;
export const CH_LP = 0x1B;
export const CH_LBD = 0x1C;

export const DEFAULT_FEET = { kickSplit: true, hhClose: true, runMs: 130 };

// Per-note edits, keyed by measure and tick so they survive regeneration:
//   `${bar}:${tick}:K`  -> 'R' | 'L'   which foot plays the kick there
//   `${bar}:${tick}:LP` -> '+' | '-'   force a hi-hat pedal note there, or none
export function kickKey(bar, tick) { return `${bar}:${tick}:K`; }
export function pedalKey(bar, tick) { return `${bar}:${tick}:LP`; }

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// Seconds from the chart start of (bar, tick), following the tempo map.
function timeFn(model) {
  const segs = barSegments(model);
  const perTick = (bpm) => 60 / (bpm * model.division);
  const barTime = [0];
  for (let b = 0; b < model.bars.length; b++) {
    let t = barTime[b];
    segs[b].forEach((s, j) => {
      const end = j + 1 < segs[b].length ? segs[b][j + 1].tick : model.bars[b].ticks;
      t += (end - s.tick) * perTick(s.bpm);
    });
    barTime.push(t);
  }
  return (bar, tick) => {
    let t = barTime[bar];
    const ss = segs[bar];
    for (let j = 0; j < ss.length && ss[j].tick < tick; j++) {
      const end = Math.min(tick, j + 1 < ss.length ? ss[j + 1].tick : tick);
      t += (end - ss[j].tick) * perTick(ss[j].bpm);
    }
    return t;
  };
}

// opts: { kickSplit, hhClose, runMs }; edits: { [key]: action } (see above).
export function assignFeet(model, opts = DEFAULT_FEET, edits = {}) {
  const o = { ...DEFAULT_FEET, ...opts };
  const timeOf = timeFn(model);

  // Working copy: per bar, a Map tick -> Set of channels (dedupes same-tick
  // duplicates such as GM 35 + 36 both mapping to the bass drum).
  const bars = model.bars.map((b) => {
    const at = new Map();
    for (const n of b.notes) {
      if (!at.has(n.tick)) at.set(n.tick, new Set());
      at.get(n.tick).add(n.ch);
    }
    return at;
  });
  const has = (bar, tick, ch) => !!bars[bar].get(tick)?.has(ch);
  const add = (bar, tick, ch) => {
    if (!bars[bar].has(tick)) bars[bar].set(tick, new Set());
    bars[bar].get(tick).add(ch);
  };
  const remove = (bar, tick, ch) => bars[bar].get(tick)?.delete(ch);

  // Events of the given channels in time order.
  const events = (chs) => {
    const out = [];
    bars.forEach((at, bar) => {
      for (const [tick, set] of at) {
        for (const ch of set) if (chs.includes(ch)) out.push({ bar, tick, ch });
      }
    });
    // Same instant: pedal, then closed, then open (so open+closed ends open).
    const rank = { [CH_LP]: 0, [CH_HHC]: 1, [CH_HHO]: 2 };
    return out.sort((a, b) => a.bar - b.bar || a.tick - b.tick || (rank[a.ch] ?? 0) - (rank[b.ch] ?? 0));
  };

  // 1. Hi-hat closes: the foot shuts an open hi-hat on the next closed hit.
  if (o.hhClose) {
    let open = false;
    for (const e of events([CH_LP, CH_HHC, CH_HHO])) {
      if (e.ch === CH_HHO) open = true;
      else if (e.ch === CH_LP) open = false;
      else if (open) {
        add(e.bar, e.tick, CH_LP);
        open = false;
      }
    }
  }

  // 2. Pedal edits, before kicks so the left foot sees the final pedal notes.
  for (const [key, action] of Object.entries(edits)) {
    const m = /^(\d+):(\d+):LP$/.exec(key);
    if (!m) continue;
    const bar = +m[1], tick = +m[2];
    if (!bars[bar] || tick >= model.bars[bar].ticks) continue;
    if (action === '+') add(bar, tick, CH_LP);
    else if (action === '-') remove(bar, tick, CH_LP);
  }

  // 3. Kicks: alternate feet inside fast runs, by grid position.
  const kicks = events([CH_BD, CH_LBD]);
  const foot = kicks.map((k) => (k.ch === CH_LBD ? 'L' : 'R'));
  if (o.kickSplit && kicks.length > 1) {
    const limit = o.runMs / 1000 + 1e-6;
    const times = kicks.map((k) => timeOf(k.bar, k.tick));
    let i = 0;
    while (i < kicks.length) {
      let j = i;
      while (j + 1 < kicks.length && times[j + 1] - times[j] <= limit) j++;
      if (j > i) {
        // Grid: the finest spacing inside the run, measured within bars so
        // odd-length measures don't shift the pattern.
        let s = 0;
        for (let k = i; k <= j; k++) s = gcd(s, kicks[k].tick);
        s ||= model.division;
        for (let k = i; k <= j; k++) {
          foot[k] = Math.round(kicks[k].tick / s) % 2 ? 'L' : 'R';
          // A gap in the run can line up two notes on one foot; if they are
          // still too close for one foot, switch.
          if (k > i && foot[k] === foot[k - 1] && times[k] - times[k - 1] <= limit) {
            foot[k] = foot[k] === 'L' ? 'R' : 'L';
          }
        }
      }
      i = j + 1;
    }
    // The left foot can't kick while it is on the hi-hat pedal.
    kicks.forEach((k, n) => {
      if (foot[n] === 'L' && has(k.bar, k.tick, CH_LP)) foot[n] = 'R';
    });
  }

  // 4. Kick edits win over everything.
  kicks.forEach((k, n) => {
    const e = edits[kickKey(k.bar, k.tick)];
    if (e === 'R' || e === 'L') foot[n] = e;
  });
  kicks.forEach((k) => {
    remove(k.bar, k.tick, CH_BD);
    remove(k.bar, k.tick, CH_LBD);
  });
  kicks.forEach((k, n) => add(k.bar, k.tick, foot[n] === 'L' ? CH_LBD : CH_BD));

  return {
    ...model,
    bars: model.bars.map((b, bar) => {
      const notes = [];
      for (const [tick, set] of [...bars[bar]].sort((x, y) => x[0] - y[0])) {
        for (const ch of [...set].sort((x, y) => x - y)) notes.push({ tick, ch });
      }
      return { ...b, notes };
    }),
  };
}
