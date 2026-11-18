// assignSlices: every drum chip plays its own hit, cut from its stem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignSlices, snapOnset, MAX_SLICE_S } from '../js/stemslice.js';

const SR = 8000;

// A stem of `seconds` with a decaying burst starting at each time in `hits`.
function stem(seconds, hits) {
  const data = new Float32Array(Math.round(seconds * SR));
  for (const t of hits) {
    const s = Math.round(t * SR);
    for (let i = 0; i < 0.05 * SR && s + i < data.length; i++) data[s + i] += Math.sin(i * 0.9) * Math.exp(-i / 80);
  }
  return { data, sr: SR };
}
const close = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b} (±${eps})`);

test('snapOnset finds a hit charted up to 20 ms off, and leaves quiet spots alone', () => {
  const { data } = stem(2, [1.0]);
  close(snapOnset(data, SR, 1.015), 1.0, 0.006);
  close(snapOnset(data, SR, 0.985), 1.0, 0.006);
  assert.equal(snapOnset(data, SR, 0.5), 0.5); // silence: unchanged
});

test('each chip gets the slice from its onset to the next hit on its stem', () => {
  const kick = stem(3, [0.5, 1.0, 1.5]);
  const snare = stem(3, [0.75, 1.25]);
  const chips = [
    { time: 2.51, ch: 0x13 }, { time: 2.75, ch: 0x12 }, { time: 3.0, ch: 0x13 },
    { time: 3.25, ch: 0x12 }, { time: 3.49, ch: 0x1C }, // LBD uses the kick stem too
  ];
  const n = assignSlices(chips, 2.0, { kick, snare }); // recording starts at song time 2
  assert.equal(n, 5);
  const [k1, s1, k2, s2, k3] = chips.map((c) => c.slice);
  assert.equal(k1.stem, 'kick');
  assert.equal(s1.stem, 'snare');
  assert.equal(k3.stem, 'kick');
  close(k1.off, 0.5 - 0.003, 0.006); // starts just before the onset
  close(k1.off + k1.len, k2.off, 1e-9); // ends where the next kick starts
  close(s1.off + s1.len, s2.off, 1e-9);
  close(k3.off + k3.len, 3, 1e-9); // last hit runs to the end of the stem
});

test('fallback stems, missing stems, out-of-range and duplicate chips', () => {
  const cymbals = stem(10, [1, 6]);
  const kick = stem(10, [1]);
  const chips = [
    { time: 1, ch: 0x16 }, // crash -> cymbals (no crash stem)
    { time: 1, ch: 0x13 },
    { time: 1.005, ch: 0x1C }, // LBD 5 ms after BD: same hit
    { time: 1, ch: 0x12 }, // snare: no stem, no slice
    { time: 6, ch: 0x16 }, // last cymbal: capped at MAX_SLICE_S
    { time: 20, ch: 0x13 }, // after the recording
  ];
  assignSlices(chips, 0, { cymbals, kick });
  assert.equal(chips[0].slice.stem, 'cymbals');
  assert.ok(chips[1].slice.len > 0);
  assert.deepEqual(chips[2].slice, { stem: 'kick', off: 0, len: 0 });
  assert.equal(chips[3].slice, undefined);
  close(chips[4].slice.len, MAX_SLICE_S, 1e-9);
  assert.equal(chips[5].slice.len, 0);
});
