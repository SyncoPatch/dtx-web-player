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
