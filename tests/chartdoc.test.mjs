// Editor document: exact DTX round trip, timing, editing operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDTX } from '../js/dtx.js';
import {
  fromDtx, toDtx, timing, positionAt, addEvents, removeEvents, shiftEvents, addWav, wavList,
  getHeader, setHeader, commonWav, frac, measureCount, extend,
} from '../js/chartdoc.js';

// Same timeline: chips (time, channel, sound), bars, tempo changes.
function assertSameTimeline(a, b) {
  const A = parseDTX(a), B = parseDTX(b);
  const chips = (d) => d.chips.map((c) => [c.time.toFixed(6), c.ch, c.wav]).sort().join('|');
  assert.equal(chips(B), chips(A));
  assert.deepEqual(B.bars.map((x) => [x.time.toFixed(6), x.beats]), A.bars.map((x) => [x.time.toFixed(6), x.beats]));
  assert.deepEqual(B.bpmChanges.map((x) => [x.time.toFixed(6), x.bpm]), A.bpmChanges.map((x) => [x.time.toFixed(6), x.bpm]));
  assert.equal(B.title, A.title);
  assert.equal(B.bpm, A.bpm);
  assert.deepEqual([...B.wavs], [...A.wavs]);
}

const FIXTURE = [
  '; Created by some editor',
  '#TITLE: テスト曲 (Test)',
  '#ARTIST: Band',
  '#BPM: 140',
  '#DLEVEL: 55',
  '#WAV01: bd.wav',
  '#WAV02: sd.ogg ; snare',
  '#WAV0A: bgm.ogg',
  '#VOLUME02: 80',
  '#BPM01: 175.5',
  '#AVI01: movie.avi',
  '#STAGEFILE: stage.png',
  '',
  '#00001: 0A',
  '#00011: 01010101',
  '#00013: 0100000000000000000000000000000001000000000000000000000000000000',
  '#00112: 00020000000200000002000000020000000200000002000000020000000200000002000000020000000200000002000000020000000200000002000000020000000200000002000000020000000200000002000000020000000200000002000000020000000200000002', // 192-ish odd length
  '#00102: 0.75',
  '#00114: 01020301020301', // resolution 7
  '#00208: 0001',
  '#00313: 01',
  '#00302: 1.5',
  '#00403: 78', // hex/base36 BPM channel
  '#00454: 01', // BGA channel, untouched
  '#00561: 02', // SE channel
  '#00511: 01_01 01 01', // separators
  '#00611: 01',
  '#00611: 0002', // a second line for the same channel
].join('\r\n');

test('round trip keeps the timeline, headers and comments', () => {
  const doc = fromDtx(FIXTURE);
  const out = toDtx(doc);
  assertSameTimeline(FIXTURE, out);
  for (const keep of ['; Created by some editor', '#WAV02: sd.ogg ; snare', '#AVI01: movie.avi', '#STAGEFILE: stage.png', '#VOLUME02: 80']) {
    assert.ok(out.includes(keep), keep);
  }
  assert.ok(out.includes('#00454: 01'));
  // Stable: a second round trip is byte-identical.
  assert.equal(toDtx(fromDtx(out)), out);
});

test('channel 02 persists and is written only where it changes', () => {
  const doc = fromDtx(FIXTURE);
  assert.deepEqual(doc.lens.slice(0, 7), [1, 0.75, 0.75, 1.5, 1.5, 1.5, 1.5]);
  const out = toDtx(doc);
  assert.deepEqual(out.match(/#\d{3}02: .*/g), ['#00102: 0.75', '#00302: 1.5']);
});

test('a 999-measure chart', () => {
  const lines = ['#BPM: 200', '#WAV01: x.wav'];
  for (let m = 0; m < 1000; m += 7) lines.push(`#${String(m).padStart(3, '0')}11: 0101`);
  const text = lines.join('\n');
  assertSameTimeline(text, toDtx(fromDtx(text)));
});

test('timing follows BPM changes like the parser', () => {
  const doc = fromDtx(FIXTURE);
  const t = timing(doc);
  const dtx = parseDTX(FIXTURE);
  for (const bar of dtx.bars.slice(0, 7)) {
    assert.ok(Math.abs(t.timeOfBeat(t.starts[bar.num]) - bar.time) < 1e-9, `bar ${bar.num}`);
  }
  const b = t.beatOfTime(dtx.bars[5].time + 0.1);
  assert.ok(Math.abs(t.timeOfBeat(b) - (dtx.bars[5].time + 0.1)) < 1e-9);
});

test('positionAt snaps to the grid inside a measure', () => {
  const doc = fromDtx('#BPM: 120\n#00102: 0.75\n#00211: 01');
  assert.deepEqual(positionAt(doc, 1.1, 16), { m: 0, pos: frac(1, 4) });
  assert.deepEqual(positionAt(doc, 4 + 2.0, 16), { m: 1, pos: frac(2, 3) }); // 3/4 bar: 12 steps
  assert.deepEqual(positionAt(doc, 4 + 2.9, 16), { m: 2, pos: frac(0, 1) }); // next bar line
  assert.deepEqual(positionAt(doc, 3.99, 16), { m: 1, pos: frac(0, 1) }); // rounds into the next measure
  assert.equal(positionAt(doc, -1, 16), null);
  assert.equal(positionAt(doc, 100, 16), null);
});

test('add, remove and move notes', () => {
  let doc = fromDtx('#BPM: 120\n#WAV01: hh.wav\n#WAV02: sd.wav\n#00011: 01010101\n#00112: 02');
  assert.equal(commonWav(doc, 0x11), '01');
  doc = addEvents(doc, [{ m: 0, ch: 0x12, pos: frac(2, 4), val: '02' }]);
  doc = removeEvents(doc, [{ m: 0, ch: 0x11, pos: frac(1, 4), val: '01' }]);
  let text = toDtx(doc);
  assert.match(text, /#00011: 01000101/);
  assert.match(text, /#00012: 0002/);
  // Move the snare from beat 2 to beat 4.5 (into measure 1), onto the high tom.
  const sd = doc.events.find((e) => e.ch === 0x12 && e.m === 0);
  doc = shiftEvents(doc, [sd], 2.5, { mapCh: () => 0x14, grid: 16 });
  text = toDtx(doc);
  assert.match(text, /#00114: 0002/);
  assert.doesNotMatch(text, /#00012/);
  assert.equal(shiftEvents(doc, [doc.events[0]], -10, { grid: 16 }), null);
  // Adding on an occupied spot replaces it.
  doc = addEvents(doc, [{ m: 0, ch: 0x11, pos: frac(0, 4), val: '02' }]);
  assert.equal(doc.events.filter((e) => e.m === 0 && e.ch === 0x11 && e.pos.n === 0).length, 1);
});

test('headers and sounds', () => {
  let doc = fromDtx('#TITLE: A\n#WAV01: a.wav\n#00011: 01');
  doc = setHeader(doc, 'TITLE', 'B');
  assert.equal(getHeader(doc, 'TITLE'), 'B');
  let val;
  [doc, val] = addWav(doc, 'b.ogg');
  assert.equal(val, '02');
  [doc, val] = addWav(doc, 'A.WAV');
  assert.equal(val, '01');
  assert.deepEqual([...wavList(doc)], [['01', 'a.wav'], ['02', 'b.ogg']]);
  assert.equal(parseDTX(toDtx(doc)).title, 'B');
});

test('extra empty measures at the end', () => {
  const doc = extend(fromDtx('#00002: 0.5\n#00011: 01'), 4);
  assert.equal(measureCount(doc), 4);
  assert.deepEqual(doc.lens, [0.5, 0.5, 0.5, 0.5]);
});
