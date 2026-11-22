// writeDtx (beat-domain model -> DTX text), checked by parsing the result back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeDtx } from '../js/dtxwrite.js';
import { parseDTX } from '../js/dtx.js';

const KIT = new Map([[0x13, 'bd.wav'], [0x12, 'sd.wav'], [0x11, 'hh.wav']]);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

function model(over = {}) {
  return {
    title: 'Song', artist: 'Band', division: 480,
    bars: [
      { ticks: 1920, notes: [{ tick: 0, ch: 0x13 }, { tick: 960, ch: 0x12 }] },
      { ticks: 1440, notes: [{ tick: 480, ch: 0x11 }] }, // 3/4
    ],
    tempos: [{ bar: 0, tick: 0, bpm: 120 }, { bar: 1, tick: 0, bpm: 90 }],
    ...over,
  };
}

test('notes, tempo change and bar length round-trip through the parser', () => {
  const m = model();
  const d = parseDTX(writeDtx(m, m.tempos, { wavs: KIT }));
  assert.equal(d.title, 'Song');
  assert.equal(d.artist, 'Band');
  assert.equal(d.bpm, 120);
  const notes = d.chips.filter((c) => c.visible).map((c) => [c.ch, c.time]);
  assert.deepEqual(notes.map((n) => n[0]), [0x13, 0x12, 0x11]);
  close(notes[0][1], 0);
  close(notes[1][1], 1); // half of a 4/4 bar at 120
  close(notes[2][1], 2 + 60 / 90); // one beat into bar 1 at 90
  assert.deepEqual(d.bars.map((b) => b.beats), [4, 3, 3]);
});

test('recording on the BGM channel, kit volume, header sanitizing', () => {
  const m = model({ title: 'A;B\nC' });
  const text = writeDtx(m, m.tempos, { wavs: KIT, kitVolume: 80, bgm: { file: 'rec.ogg', bar: 0, tick: 240 } });
  const d = parseDTX(text);
  assert.equal(d.title, 'A；B C'); // ';' would start a comment, newlines a new record
  const bgm = d.chips.find((c) => c.ch === 0x01);
  close(bgm.time, 0.25);
  assert.equal(d.wavs.get(bgm.wav).file, 'rec.ogg');
  assert.equal(d.wavs.get(bgm.wav).volume, 100);
  for (const id of [1, 2, 3]) assert.equal(d.wavs.get(id).volume, 80);
});

test('channels without a kit sound are left out', () => {
  const m = model();
  m.bars[0].notes.push({ tick: 0, ch: 0x16 }); // cymbal, not in KIT
  const d = parseDTX(writeDtx(m, m.tempos, { wavs: KIT }));
  assert.ok(!d.chips.some((c) => c.ch === 0x16));
});

test('many fractional tempos: rounding does not drift', () => {
  // 64 bars, a new odd tempo every beat. The exact end time and the parsed
  // end time must agree to well under a millisecond.
  const bars = Array.from({ length: 64 }, () => ({ ticks: 1920, notes: [{ tick: 0, ch: 0x13 }] }));
  const tempos = [];
  let exact = 0;
  bars.forEach((b, bar) => {
    for (let beat = 0; beat < 4; beat++) {
      const bpm = 100 + ((bar * 4 + beat) * 7.123) % 60;
      tempos.push({ bar, tick: beat * 480, bpm });
      exact += 60 / bpm;
    }
  });
  const m = model({ bars, tempos });
  const d = parseDTX(writeDtx(m, tempos, { wavs: KIT }));
  const lastBar = d.bars[d.bars.length - 1];
  close(lastBar.time, exact, 1e-3);
  const kicks = d.chips.filter((c) => c.ch === 0x13);
  assert.equal(kicks.length, 64);
});

test('rejects positions outside their measure', () => {
  const m = model();
  m.bars[1].notes.push({ tick: 1440, ch: 0x13 });
  assert.throws(() => writeDtx(m, m.tempos, { wavs: KIT }), /whole ticks/);
  const m2 = model();
  assert.throws(() => writeDtx(m2, m2.tempos, { wavs: KIT, bgm: { file: 'x', bar: 5, tick: 0 } }), /recording position/);
  assert.throws(() => writeDtx(model({ bars: [] })), /no measures/);
});
