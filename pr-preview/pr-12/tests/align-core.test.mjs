// alignBars: find every measure start of a chart in a synthesized recording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SR, onsetFeatures, alignBars } from '../js/align-core.js';

const BARS = 16, BAR_S = 2; // 4/4 at 120 BPM in the score
const scoreTimes = Array.from({ length: BARS + 1 }, (_, b) => b * BAR_S);

// Groove: kicks on 1 and 3, snares on 2 and 4, eighth hi-hats, a fill in bar 7.
function chart() {
  const notes = [];
  for (let bar = 0; bar < BARS; bar++) {
    for (let e = 0; e < 8; e++) notes.push({ bar, frac: e / 8, kind: 'hh' });
    notes.push({ bar, frac: 0, kind: 'kick' }, { bar, frac: 0.5, kind: 'kick' });
    notes.push({ bar, frac: 0.25, kind: 'snare' }, { bar, frac: 0.75, kind: 'snare' });
    if (bar === 7) for (let s = 13; s < 16; s++) notes.push({ bar, frac: s / 16, kind: 'snare' });
  }
  return notes;
}
const WEIGHTS = { kick: [1, 0, 0], snare: [0, 1, 0.3], hh: [0, 0, 1] };

function render(notes, audioTimeOf, seconds) {
  const out = new Float32Array(Math.round(seconds * SR));
  let seed = 7;
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1;
  for (const n of notes) {
    const s0 = Math.round(audioTimeOf(n.bar, n.frac) * SR);
    let prev = 0;
    for (let i = 0; i < 0.15 * SR && s0 + i < out.length; i++) {
      const t = i / SR;
      let v;
      if (n.kind === 'kick') v = Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t / 0.06);
      else if (n.kind === 'snare') v = (0.6 * noise() + 0.4 * Math.sin(2 * Math.PI * 220 * t)) * Math.exp(-t / 0.04);
      else { const x = noise(); v = (x - prev) * 0.5 * Math.exp(-t / 0.015); prev = x; } // high-passed noise
      out[s0 + i] += 0.5 * v;
    }
  }
  return out;
}

function run(audioTimeOf, seconds) {
  const notes = chart();
  const samples = render(notes, audioTimeOf, seconds);
  const features = onsetFeatures(samples);
  const res = alignBars(features, notes.map((n) => ({ bar: n.bar, frac: n.frac, w: WEIGHTS[n.kind] })), scoreTimes);
  const expected = scoreTimes.map((t, b) => audioTimeOf(Math.min(b, BARS - 1), b === BARS ? 1 : 0));
  const errMs = res.barTimes.map((t, b) => Math.abs(t - expected[b]) * 1000);
  return { res, errMs };
}

test('steady tempo with an offset: bar starts within 10 ms, detected as constant', () => {
  // The recording starts 2.5 s in and runs 3% slower than the score.
  const at = (bar, frac) => 2.5 + 1.03 * (bar + frac) * BAR_S;
  const { res, errMs } = run(at, 2.5 + 1.03 * BARS * BAR_S + 1);
  assert.ok(Math.max(...errMs.slice(0, BARS)) < 10, `errors ${errMs.map((e) => e.toFixed(1))}`);
  assert.equal(res.method, 'constant');
  assert.ok(res.overall > 0.5, `confidence ${res.overall}`);
});

test('a drummer speeding up: tracked bar by bar within 20 ms', () => {
  // Tempo drifts from 112 to 128 BPM over the song (bar length shrinks).
  const barLen = (b) => BAR_S * 120 / (112 + 16 * b / (BARS - 1));
  const starts = [1.2];
  for (let b = 0; b < BARS; b++) starts.push(starts[b] + barLen(b));
  const at = (bar, frac) => starts[bar] + frac * barLen(bar);
  const { res, errMs } = run(at, starts[BARS] + 1);
  assert.ok(Math.max(...errMs.slice(0, BARS)) < 20, `errors ${errMs.map((e) => e.toFixed(1))}`);
  assert.equal(res.method, 'tracked');
});
