// Editor document: exact DTX round trip, timing, editing operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDTX } from '../js/dtx.js';
import {
  fromDtx, toDtx, timing, positionAt, addEvents, removeEvents, shiftEvents, addWav, wavList,
  getHeader, setHeader, commonWav, frac, measureCount, extend,
  toFrac, insertMeasures, deleteMeasures, setMeasureLength, eventsPastLength, lengthRunEnd,
  setBpm, removeBpm, bpmEventAt, wavUsage, setEventsVal,
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

// Times of the drum chips, from the real parser.
const drumTimes = (doc) => parseDTX(toDtx(doc)).chips.filter((c) => c.ch >= 0x11 && c.ch <= 0x1C).map((c) => c.time);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

test('toFrac reads written measure lengths exactly', () => {
  assert.deepEqual(toFrac(0.875), frac(7, 8));
  assert.deepEqual(toFrac(0.75), frac(3, 4));
  assert.deepEqual(toFrac(1.5), frac(3, 2));
  assert.deepEqual(toFrac(1), frac(1, 1));
  assert.deepEqual(toFrac(5 / 12), frac(5, 12));
});

test('inserting a measure shifts later notes by exactly one measure', () => {
  // 120 BPM, then 60 BPM from measure 2.
  const src = '#BPM: 120\n#WAV01: a.wav\n#BPM01: 60\n#00011: 01\n#00111: 01\n#00208: 01\n#00211: 01\n#00311: 01';
  const doc = fromDtx(src);
  const before = drumTimes(doc);
  // Before measure 1 (at 120 BPM: 2 s).
  let after = drumTimes(insertMeasures(doc, 1));
  near(after[0], before[0], 'm0');
  for (let i = 1; i < 4; i++) near(after[i], before[i] + 2, `note ${i}`);
  // Before measure 3 (at 60 BPM: 4 s); the tempo change stays at measure 2.
  after = drumTimes(insertMeasures(doc, 3));
  for (let i = 0; i < 3; i++) near(after[i], before[i], `note ${i}`);
  near(after[3], before[3] + 4, 'last');
  // Inside a 3/4 stretch the new measure is 3/4 too.
  const w = insertMeasures(fromDtx('#00102: 0.75\n#00111: 01\n#00211: 01'), 2);
  assert.deepEqual(w.lens, [1, 0.75, 0.75, 0.75]);
  assert.match(toDtx(w), /#00311: 01/);
});

test('deleting a measure keeps the tempo that followed it', () => {
  const src = '#BPM: 120\n#WAV01: a.wav\n#BPM01: 60\n#00011: 01\n#00108: 01\n#00111: 0101\n#00211: 01';
  const doc = fromDtx(src);
  const before = drumTimes(doc);
  const out = deleteMeasures(doc, 1);
  const after = drumTimes(out);
  assert.equal(after.length, 2);
  near(after[0], before[0], 'm0');
  near(after[1], 2, 'm2 moved back one 120 BPM measure');
  // The 60 BPM change now starts the old measure 2.
  assert.ok(bpmEventAt(out, 1, frac(0, 1)));
  const dtx = parseDTX(toDtx(out));
  assert.deepEqual(dtx.bpmChanges.map((c) => [c.time, c.bpm]), [[2, 60]]);
  assert.equal(measureCount(out), 2);
});

test('a new measure length keeps each note on its beat', () => {
  const doc = fromDtx('#BPM: 60\n#WAV01: a.wav\n#00011: 01010101\n#00111: 01\n#00211: 01');
  assert.equal(eventsPastLength(doc, 0, 1, 0.75).length, 1);
  const out = setMeasureLength(doc, 0, 1, 0.75);
  assert.deepEqual(drumTimes(out), [0, 1, 2, 3, 7]);
  assert.deepEqual(out.lens.slice(0, 3), [0.75, 1, 1]);
  assert.match(toDtx(out), /#00002: 0\.75\r\n#00011: 010101\r\n#00102: 1\r\n/);
  // 7/8, then longer again: positions stay exact.
  const odd = setMeasureLength(setMeasureLength(doc, 0, 3, 0.875), 0, 3, 1.25);
  assert.deepEqual(drumTimes(odd), [0, 1, 2, 3, 5, 10]);
  // A run of equal lengths ends where the length changes.
  const run = fromDtx('#00102: 0.75\n#00302: 1\n#00511: 01');
  assert.equal(lengthRunEnd(run, 1), 3);
  assert.equal(lengthRunEnd(run, 4), 6); // to the end of the chart
});

test('tempo changes: header at the start, #BPMxx elsewhere', () => {
  let doc = fromDtx('#BPM: 120\n#WAV01: a.wav\n#00011: 01\n#00111: 01\n#00211: 01\n#00311: 01');
  doc = setBpm(doc, 0, frac(0, 1), 60);
  assert.equal(getHeader(doc, 'BPM'), '60');
  doc = setBpm(doc, 1, frac(0, 1), 150.5);
  doc = setBpm(doc, 3, frac(0, 1), 150.5); // same value: same definition
  const text = toDtx(doc);
  assert.equal(text.match(/#BPM\w\w: 150\.5/g).length, 1);
  assert.match(text, /#00108: 01/);
  assert.match(text, /#00308: 01/);
  const spb = 60 / 150.5;
  assert.deepEqual(drumTimes(doc).map((t) => Math.round(t * 1e6)), [0, 4, 4 + 4 * spb, 4 + 8 * spb].map((t) => Math.round(t * 1e6)));
  // Replacing and removing.
  doc = setBpm(doc, 1, frac(0, 1), 240);
  assert.equal(parseDTX(toDtx(doc)).bpmChanges[0].bpm, 240);
  doc = removeBpm(doc, 1, frac(0, 1));
  assert.equal(bpmEventAt(doc, 1, frac(0, 1)), null);
  assert.deepEqual(parseDTX(toDtx(doc)).bpmChanges.map((c) => c.bpm), [150.5]);
  assert.throws(() => setBpm(doc, 1, frac(0, 1), 0));
});

test('sound usage and changing a note’s sound', () => {
  let doc = fromDtx('#WAV01: a.wav\n#WAV02: b.wav\n#00001: 02\n#00011: 0101\n#00012: 01');
  assert.deepEqual([...wavUsage(doc)].sort(), [['01', 3], ['02', 1]]);
  doc = setEventsVal(doc, doc.events.filter((e) => e.ch === 0x11), '02');
  assert.match(toDtx(doc), /#00011: 0202/);
  assert.deepEqual([...wavUsage(doc)].sort(), [['01', 1], ['02', 3]]);
});
