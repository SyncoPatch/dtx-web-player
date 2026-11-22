// Count-in: N bars of clicks that end exactly where playback starts.
// Pure, so it runs under `node --test`.
//
// The bar that contains the start point sets the meter: one click per
// quarter note of its length (bar.beats, in quarters), so a 7/8 bar counts
// 1 2 3 4 with a short last beat. The tempo is the one in force at the start
// point. Times are song seconds; the player divides by play speed.

const EPS = 1e-6;

// bars: [{ time, beats }]; bpm: the chart's initial #BPM;
// bpmChanges: [{ time, bpm }] sorted; t: start point; n: number of bars.
// Returns { seconds, clicks: [{ t, accent, beat }] } (t < start, ascending;
// beat counts 1, 2, 3… within each bar), or null when n is 0.
export function countInPlan({ bars = [], bpm = 120, bpmChanges = [] }, t, n) {
  if (!(n > 0)) return null;
  let tempo = bpm > 0 ? bpm : 120;
  for (const c of bpmChanges) {
    if (c.time > t + EPS) break;
    if (c.bpm > 0) tempo = c.bpm;
  }
  let bar = bars[0];
  for (const b of bars) {
    if (b.time > t + EPS) break;
    bar = b;
  }
  const quarters = bar?.beats > 0 ? bar.beats : 4;
  const q = 60 / tempo;
  const barSec = quarters * q;
  const seconds = n * barSec;
  const clicks = [];
  const start = t - seconds;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < quarters - EPS; k++) {
      clicks.push({ t: start + i * barSec + k * q, accent: k === 0, beat: k + 1 });
    }
  }
  return { seconds, clicks };
}
