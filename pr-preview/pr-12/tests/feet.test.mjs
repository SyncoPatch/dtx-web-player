// assignFeet: kick runs split between feet, hi-hat pedal closes, edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignFeet, kickKey, pedalKey, CH_BD, CH_LBD, CH_HHC, CH_HHO, CH_LP } from '../js/feet.js';

// One 4/4 bar at `bpm`, division 480 (16th = 120 ticks).
const bar = (notes, bpm = 120) => ({
  division: 480,
  bars: [{ ticks: 1920, notes: notes.map(([tick, ch]) => ({ tick, ch })) }],
  tempos: [{ bar: 0, tick: 0, bpm }],
});
const chs = (m, tick) => m.bars[0].notes.filter((n) => n.tick === tick).map((n) => n.ch);
const kicks = (m) => m.bars[0].notes.filter((n) => n.ch === CH_BD || n.ch === CH_LBD).map((n) => [n.tick, n.ch === CH_LBD ? 'L' : 'R']);

test('fast 16th kicks alternate R L R L by grid position', () => {
  // 16ths at 120 BPM are 125 ms apart, inside the 130 ms run limit.
  const m = assignFeet(bar([[0, CH_BD], [120, CH_BD], [240, CH_BD], [360, CH_BD]]));
  assert.deepEqual(kicks(m), [[0, 'R'], [120, 'L'], [240, 'R'], [360, 'L']]);
});

test('slow kicks stay on the right foot', () => {
  const m = assignFeet(bar([[0, CH_BD], [480, CH_BD], [960, CH_BD]]));
  assert.deepEqual(kicks(m), [[0, 'R'], [480, 'R'], [960, 'R']]);
});

test('a run starting off the beat keeps grid parity', () => {
  const m = assignFeet(bar([[120, CH_BD], [240, CH_BD]]));
  assert.deepEqual(kicks(m), [[120, 'L'], [240, 'R']]);
});

test('kickSplit off leaves every kick on the bass drum', () => {
  const m = assignFeet(bar([[0, CH_BD], [120, CH_BD]]), { kickSplit: false, hhClose: false });
  assert.deepEqual(kicks(m), [[0, 'R'], [120, 'R']]);
});

test('an open hi-hat is closed with the pedal on the next closed hit', () => {
  const m = assignFeet(bar([[0, CH_HHO], [480, CH_HHC], [960, CH_HHC]]));
  assert.deepEqual(chs(m, 480).sort(), [CH_HHC, CH_LP].sort());
  assert.ok(!chs(m, 960).includes(CH_LP), 'only the first closed hit after an open one');
  const off = assignFeet(bar([[0, CH_HHO], [480, CH_HHC]]), { hhClose: false });
  assert.ok(!chs(off, 480).includes(CH_LP));
});

test('the left foot cannot kick while it is on the pedal', () => {
  // The kick at 120 would be L, but the pedal closes the hi-hat there.
  const m = assignFeet(bar([[0, CH_HHO], [0, CH_BD], [120, CH_HHC], [120, CH_BD]]));
  assert.ok(chs(m, 120).includes(CH_LP));
  assert.deepEqual(kicks(m), [[0, 'R'], [120, 'R']]);
});

test('edits override the rules', () => {
  const src = bar([[0, CH_BD], [120, CH_BD], [0, CH_HHO], [480, CH_HHC]]);
  const m = assignFeet(src, undefined, {
    [kickKey(0, 0)]: 'L',
    [pedalKey(0, 480)]: '-',
    [pedalKey(0, 960)]: '+',
  });
  assert.deepEqual(kicks(m)[0], [0, 'L']);
  assert.ok(!chs(m, 480).includes(CH_LP));
  assert.ok(chs(m, 960).includes(CH_LP));
});

test('the source model is not changed, and same-tick duplicates merge', () => {
  const src = bar([[0, CH_BD], [0, CH_BD], [120, CH_BD]]);
  const before = JSON.stringify(src);
  const m = assignFeet(src);
  assert.equal(JSON.stringify(src), before);
  assert.equal(kicks(m).length, 2);
});
