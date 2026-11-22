// Library tree scanning (DTXMania folder rules), def parsing, search helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanTree, parseBoxDef, writeBoxDef, parseSetDefSongs, normalizeForSearch, searchTerms,
  matchTerms, songHaystack, boxPathOf, descendantIds, passesFilters, SORTS, makeResolver,
} from '../js/library.js';

const readText = (b) => b.text();
const tree = (files) => Object.entries(files).map(([path, text]) => ({ path, blob: new Blob([text]) }));
const chart = (title, level, wavs = {}) =>
  `#TITLE: ${title}\n#ARTIST: Band\n#DLEVEL: ${level}\n#BPM: 120\n` +
  Object.entries(wavs).map(([id, f]) => `#WAV${id}: ${f}\n`).join('') + '#00111: 01\n';

test('parseBoxDef: prefix keys, separators, comments', () => {
  const d = parseBoxDef('#TITLE: Anime ; comment\n  #GENRE\tアニメ\n#FONTCOLOR:#FF8800\nTITLE: no hash\n#PERFECTRANGE 30\n#COMMENTHello');
  assert.equal(d.title, 'Anime');
  assert.equal(d.genre, 'アニメ');
  assert.equal(d.color, '#FF8800');
  assert.equal(d.comment, 'Hello');
});

test('writeBoxDef keeps unknown keys and replaces edited ones', () => {
  const out = writeBoxDef('#TITLE: Old\r\n#PERFECTRANGE: 30\r\n', { title: 'New', genre: 'Rock', color: '' });
  assert.match(out, /#TITLE: New/);
  assert.match(out, /#PERFECTRANGE: 30/);
  assert.match(out, /#GENRE: Rock/);
  assert.doesNotMatch(out, /FONTCOLOR/);
  assert.equal(parseBoxDef(out).title, 'New');
});

test('parseSetDefSongs: several songs, labels, missing files dropped', () => {
  const songs = parseSetDefSongs(
    '#TITLE A\n#L1LABEL BASIC\n#L1FILE a1.dtx\n#L3FILE a3.dtx\n' +
    '#TITLE B\n#FONTCOLOR FF0000\n#L2LABEL ADV\n#L2FILE b.dtx\n#TITLE Empty\n#L1LABEL x\n');
  assert.deepEqual(songs.map((s) => s.title), ['A', 'B']);
  assert.deepEqual(songs[0].charts, [{ label: 'BASIC', file: 'a1.dtx' }, { label: '', file: 'a3.dtx' }]);
  assert.equal(songs[1].color, '#FF0000');
});

test('scanTree: boxes from DTXFiles. prefix and box.def; plain folders flatten', async () => {
  const { boxes, songs } = await scanTree(tree({
    'DTX/DTXFiles.Anime/Song1/s.dtx': chart('Song One', 50, { '01': 'bd.wav' }),
    'DTX/DTXFiles.Anime/Song1/bd.wav': 'x',
    'DTX/DTXFiles.Anime/Sub/Inner/box.def': '#TITLE: Inner Box\n#GENRE: Pop\n',
    'DTX/DTXFiles.Anime/Sub/Inner/Song2/s.dtx': chart('Song Two', 30),
    'DTX/Plain/Group/Song3/a.dtx': chart('Song Three', 20),
    'DTX/Plain/Group/Song3/a.ogg': 'x',
    '__MACOSX/DTX/._a.dtx': 'junk',
  }), readText);
  assert.deepEqual(boxes.map((b) => [b.title, b.parentKey]), [
    ['Anime', null],
    ['Inner Box', 'dtx/dtxfiles.anime'],
  ]);
  assert.equal(boxes[1].genre, 'Pop');
  const byTitle = Object.fromEntries(songs.map((s) => [s.title, s]));
  assert.equal(byTitle['Song One'].boxKey, 'dtx/dtxfiles.anime');
  assert.equal(byTitle['Song One'].folder, 'Song1');
  assert.deepEqual(byTitle['Song One'].files.map((f) => f.path), ['song1/bd.wav', 'song1/s.dtx']);
  assert.equal(byTitle['Song One'].dtxs[0].path, 'song1/s.dtx');
  assert.equal(byTitle['Song Two'].boxKey, 'dtx/dtxfiles.anime/sub/inner');
  assert.equal(byTitle['Song Three'].boxKey, null); // flattened to the root
  assert.equal(byTitle['Song Three'].folder, 'DTX/Plain/Group/Song3');
  assert.equal(songs.length, 3);
});

test('scanTree: one song per folder, set.def labels, sorted by level', async () => {
  const { songs } = await scanTree(tree({
    'Song/set.def': '#TITLE My Song\n#L1LABEL BASIC\n#L1FILE bas.dtx\n#L2LABEL EXTREME\n#L2FILE ext.dtx\n',
    'Song/ext.dtx': chart('My Song (EXT)', 80),
    'Song/bas.dtx': chart('My Song', 30),
    'Song/wav/bd.ogg': 'x',
  }), readText);
  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, 'My Song');
  assert.equal(songs[0].artist, 'Band');
  assert.deepEqual(songs[0].dtxs.map((d) => d.label), ['BASIC', 'EXTREME']);
  assert.deepEqual(songs[0].files.map((f) => f.path).sort(), ['song/bas.dtx', 'song/ext.dtx', 'song/set.def', 'song/wav/bd.ogg']);
});

test('scanTree: without set.def, charts of one folder form one song', async () => {
  const { songs } = await scanTree(tree({
    'P/a.dtx': chart('Title A', 50),
    'P/b.dtx': chart('Title B', 20),
  }), readText);
  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, 'Title B');
  assert.equal(songs[0].dtxs.length, 2);
});

test('scanTree: multi-song set.def keeps only each song\'s files; ../ shared sounds', async () => {
  const { songs } = await scanTree(tree({
    'Box/box.def': '#TITLE Box',
    'Box/Pack/set.def': '#TITLE One\n#L1FILE one.dtx\n#TITLE Two\n#L1FILE two.dtx\n',
    'Box/Pack/one.dtx': chart('One', 10, { '01': 'one.wav', '02': '../Shared/snare.wav' }),
    'Box/Pack/two.dtx': chart('Two', 20, { '01': 'two.wav' }),
    'Box/Pack/one.ogg': 'x', // .wav referenced, .ogg shipped
    'Box/Pack/two.wav': 'x',
    'Box/Shared/snare.wav': 'x',
  }), readText);
  const one = songs.find((s) => s.title === 'One');
  const two = songs.find((s) => s.title === 'Two');
  assert.deepEqual(one.files.map((f) => f.path), ['pack/one.dtx', 'pack/one.ogg', 'pack/set.def', 'shared/snare.wav']);
  assert.deepEqual(two.files.map((f) => f.path), ['pack/set.def', 'pack/two.dtx', 'pack/two.wav']);
  assert.equal(one.files.find((f) => f.path === 'shared/snare.wav').origPath, 'Shared/snare.wav');
  // The shared sound resolves from the chart's folder as stored.
  const fm = new Map(one.files.map((f) => [f.path, f]));
  assert.ok(makeResolver(fm, 'pack')('../Shared/snare.wav'));
});

test('scanTree: a single song at the ZIP root', async () => {
  const { boxes, songs } = await scanTree(tree({ 'a.dtx': chart('Solo', 10), 'a.wav': 'x' }), readText);
  assert.equal(boxes.length, 0);
  assert.equal(songs[0].folder, '');
  assert.deepEqual(songs[0].files.map((f) => f.path), ['a.dtx', 'a.wav']);
});

test('search normalisation folds width, case and kana', () => {
  assert.equal(normalizeForSearch('ＤＲＵＭ ドラム'), normalizeForSearch('drum どらむ'));
  assert.equal(normalizeForSearch('ｶﾞｯ'), normalizeForSearch('がっ'));
  const hay = songHaystack({ title: 'Hello', artist: 'ドラマー', dtxs: [{ title: 'Hello', label: 'EXTREME' }] },
    [{ title: 'Anime', genre: 'アニメ' }]);
  assert.ok(matchTerms(hay, searchTerms('どらまー extreme')));
  assert.ok(matchTerms(hay, searchTerms('あにめ')));
  assert.ok(!matchTerms(hay, searchTerms('hello rock')));
});

test('box paths, descendants, filters, sorts', () => {
  const boxes = [{ id: 'a', parent: null }, { id: 'b', parent: 'a' }, { id: 'c', parent: 'b' }, { id: 'd', parent: null }];
  assert.deepEqual(boxPathOf(boxes, 'c').map((b) => b.id), ['a', 'b', 'c']);
  assert.deepEqual([...descendantIds(boxes, 'a')].sort(), ['a', 'b', 'c']);
  const s = { dtxs: [{ level: 45, bpm: 150 }, { level: 7.2, bpm: 150 }], source: 'guitarpro', sync: { audio: 'x' } };
  assert.ok(passesFilters(s, { levelMin: 7, levelMax: 7.5 }));
  assert.ok(passesFilters(s, { levelMin: 4.5, levelMax: 4.5 }));
  assert.ok(!passesFilters(s, { levelMin: 8 }));
  assert.ok(!passesFilters(s, { bpmMax: 149 }));
  assert.ok(passesFilters(s, { kind: 'rec' }));
  assert.ok(!passesFilters(s, { kind: 'stems' }));
  assert.ok(!passesFilters(s, { kind: 'dtx' }));
  const list = [{ title: 'b', addedAt: 1 }, { title: 'A', addedAt: 2 }, { title: 'a2', addedAt: 3 }];
  assert.deepEqual([...list].sort(SORTS.title).map((x) => x.title), ['A', 'a2', 'b']);
  assert.deepEqual([...list].sort(SORTS.added).map((x) => x.title), ['a2', 'A', 'b']);
});

test('encodeShiftJIS round-trips through the decoder', async () => {
  const { encodeShiftJIS } = await import('../js/library.js');
  const text = '#TITLE: アニメ ｱﾆﾒ 漢字 ABC\r\n';
  const bytes = encodeShiftJIS(text);
  assert.equal(new TextDecoder('shift_jis').decode(bytes), text);
  assert.equal(new TextDecoder('shift_jis').decode(encodeShiftJIS('😀')), '?');
});
