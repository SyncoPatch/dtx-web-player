import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countInPlan } from '../js/countin.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('off', () => {
  assert.equal(countInPlan({ bars: [{ time: 0, beats: 4 }] }, 0, 0), null);
});

test('4/4 at 120 BPM, 2 bars, from the start', () => {
  const p = countInPlan({ bars: [{ time: 0, beats: 4 }, { time: 2, beats: 4 }], bpm: 120 }, 0, 2);
  close(p.seconds, 4);
  assert.equal(p.clicks.length, 8);
  close(p.clicks[0].t, -4);
  close(p.clicks[7].t, -0.5);
  assert.deepEqual(p.clicks.map((c) => c.beat), [1, 2, 3, 4, 1, 2, 3, 4]);
  assert.deepEqual(p.clicks.map((c) => c.accent), [true, false, false, false, true, false, false, false]);
});

test('7/8 counts four clicks with a short last beat', () => {
  const p = countInPlan({ bars: [{ time: 0, beats: 3.5 }], bpm: 60 }, 0, 1);
  close(p.seconds, 3.5);
  assert.deepEqual(p.clicks.map((c) => c.t), [-3.5, -2.5, -1.5, -0.5]);
});

test('tempo in force at the start point, including a change right there', () => {
  const chart = {
    bars: [{ time: 0, beats: 4 }, { time: 2, beats: 3 }],
    bpm: 120,
    bpmChanges: [{ time: 2, bpm: 180 }],
  };
  const p = countInPlan(chart, 2, 1);
  close(p.seconds, 3 * (60 / 180));
  assert.equal(p.clicks.length, 3);
  close(p.clicks[0].t, 1);
});

test('a start in the middle of a bar uses that bar and ends exactly at the start', () => {
  const chart = { bars: [{ time: 0, beats: 4 }, { time: 2, beats: 2 }, { time: 3, beats: 4 }], bpm: 120 };
  const p = countInPlan(chart, 2.5, 1);
  close(p.seconds, 1);
  close(p.clicks[0].t, 1.5);
  close(p.clicks.at(-1).t + 0.5, 2.5);
});

test('no bars falls back to 4/4', () => {
  const p = countInPlan({ bpm: 100 }, 10, 1);
  close(p.seconds, 2.4);
  assert.equal(p.clicks.length, 4);
});

import { entryBarIndex, introClicks } from '../js/countin.js';

// 120 BPM 4/4 bars of 2 s; bar 2 is 3/4 (1.5 s) and bar 3 is at 60 BPM (4 s).
const BARS = [
  { time: 0, num: 0, beats: 4 }, { time: 2, num: 1, beats: 4 }, { time: 4, num: 2, beats: 3 },
  { time: 5.5, num: 3, beats: 4 }, { time: 9.5, num: 4, beats: 4 }, { time: 11.5, num: 5, beats: 4 },
];

test('entryBarIndex: Auto = first drum bar; a number = that measure or the next', () => {
  const chips = [{ time: 0, visible: false }, { time: 9.6, visible: true }];
  assert.equal(entryBarIndex(BARS, chips, null), 4);
  assert.equal(entryBarIndex(BARS, [], null), 0);
  assert.equal(entryBarIndex(BARS, chips, 2), 2);
  assert.equal(entryBarIndex(BARS, chips, 99), 5);
  const lead = BARS.map((b) => ({ ...b, num: b.num + 1 })); // lead-in shifted numbers
  assert.equal(entryBarIndex(lead, chips, 0), 0);
});

test('introClicks: each intro bar keeps its own meter and tempo', () => {
  const r = introClicks(BARS, 4, 2);
  assert.equal(r.missing, 0);
  close(r.entryTime, 9.5);
  assert.deepEqual(r.clicks.map((c) => c.t), [4, 4.5, 5, 5.5, 6.5, 7.5, 8.5]);
  assert.deepEqual(r.clicks.map((c) => c.beat), [1, 2, 3, 1, 2, 3, 4]);
  assert.deepEqual(r.clicks.filter((c) => c.accent).map((c) => c.t), [4, 5.5]);
});

test('introClicks: a short intro reports the missing bars', () => {
  const r = introClicks(BARS, 1, 2);
  assert.equal(r.missing, 1);
  assert.equal(r.clicks.length, 4);
  const none = introClicks(BARS, 0, 2);
  assert.equal(none.missing, 2);
  assert.equal(none.clicks.length, 0);
});
