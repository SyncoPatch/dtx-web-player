// node --test tests/   (Node 20+; fixtures are built with python3's zipfile)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractZip } from '../js/zip.js';

let dir;
const PY = String.raw`
import sys, zipfile, os
out = sys.argv[1]
audio = os.urandom(50_000)           # incompressible, like real audio
text = ('#TITLE: test\n#BPM: 120\n' * 400).encode()
video = os.urandom(300_000)
with zipfile.ZipFile(f'{out}/basic.zip', 'w') as z:
    z.writestr(zipfile.ZipInfo('song/'), b'')                                   # directory entry
    z.writestr('song/chart.dtx', text, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr('song/bgm.ogg', audio, compress_type=zipfile.ZIP_STORED)
    z.writestr('song/movie.avi', video, compress_type=zipfile.ZIP_STORED)
    z.writestr('song/abcdef.wav', b'RIFFsjis', compress_type=zipfile.ZIP_STORED)  # renamed to Shift-JIS below
    z.comment = b'x' * 1000
for name, data in [('chart.dtx', text), ('bgm.ogg', audio), ('movie.avi', video)]:
    open(f'{out}/{name}', 'wb').write(data)
# Zip64: more than 65535 entries forces the Zip64 end records.
with zipfile.ZipFile(f'{out}/many.zip', 'w', allowZip64=True) as z:
    for i in range(70000):
        z.writestr(f'f/{i}.txt', str(i))
    z.writestr('f/big.bin', b'z' * 100_000, compress_type=zipfile.ZIP_DEFLATED)
`;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ziptest-'));
  execFileSync('python3', ['-I', '-c', PY, dir]);
  // Give one entry a Shift-JIS name without the UTF-8 flag, as Japanese
  // Windows zips do: same byte length as the placeholder.
  const zip = readFileSync(join(dir, 'basic.zip'));
  const from = Buffer.from('abcdef');
  const to = Buffer.from([0x83, 0x68, 0x83, 0x89, 0x83, 0x80]); // ドラム
  let i = 0, n = 0;
  while ((i = zip.indexOf(from, i)) >= 0) { to.copy(zip, i); i += 6; n++; }
  assert.equal(n, 2); // local + central header
  writeFileSync(join(dir, 'basic.zip'), zip);
});

const bytes = async (b) => new Uint8Array(await b.arrayBuffer());

test('stored, deflated and Shift-JIS entries match the originals', async () => {
  const entries = await extractZip(new Blob([readFileSync(join(dir, 'basic.zip'))]));
  const by = new Map(entries.map((e) => [e.name, e.blob]));
  assert.deepEqual([...by.keys()].sort(), ['song/bgm.ogg', 'song/chart.dtx', 'song/movie.avi', 'song/ドラム.wav']);
  for (const f of ['chart.dtx', 'bgm.ogg', 'movie.avi']) {
    assert.deepEqual(await bytes(by.get('song/' + f)), new Uint8Array(readFileSync(join(dir, f))), f);
  }
  assert.equal(new TextDecoder().decode(await bytes(by.get('song/ドラム.wav'))), 'RIFFsjis');
  assert.deepEqual(entries.skipped, []);
});

test('ArrayBuffer input still works', async () => {
  const buf = readFileSync(join(dir, 'basic.zip'));
  const entries = await extractZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  assert.equal(entries.length, 4);
});

test('skipped entries are never read', async () => {
  const ranges = [];
  class SpyBlob extends Blob {
    slice(start, end) { ranges.push([start, end]); return super.slice(start, end); }
  }
  const raw = readFileSync(join(dir, 'basic.zip'));
  const entries = await extractZip(new SpyBlob([raw]), { skip: (n) => n.endsWith('.avi') });
  assert.deepEqual(entries.map((e) => e.name).sort(), ['song/bgm.ogg', 'song/chart.dtx', 'song/ドラム.wav']);
  assert.deepEqual(entries.skipped, [{ name: 'song/movie.avi', size: 300_000 }]);
  // The video's data (300 KB) must not fall inside any range we sliced.
  const at = raw.indexOf(readFileSync(join(dir, 'movie.avi')).subarray(0, 64));
  assert.ok(at > 0);
  // The fixed-size tail read (end record search, up to 64 KB of comment) is
  // allowed to overlap; nothing else may.
  const tail = ranges.filter(([, e]) => e === raw.length);
  assert.equal(tail.length, 1);
  assert.ok(raw.length - tail[0][0] <= 22 + 65535 + 20);
  for (const [s, e] of ranges.filter((r) => r !== tail[0])) {
    assert.ok(e <= at || s >= at + 300_000, `read ${s}-${e} overlaps the video`);
  }
});

test('Zip64 archive with more than 65535 entries', async () => {
  const entries = await extractZip(new Blob([readFileSync(join(dir, 'many.zip'))]));
  assert.equal(entries.length, 70001);
  const by = new Map(entries.map((e) => [e.name, e.blob]));
  assert.equal(await by.get('f/69999.txt').text(), '69999');
  assert.equal((await bytes(by.get('f/big.bin'))).length, 100_000);
});

test('rejects a non-ZIP', async () => {
  await assert.rejects(extractZip(new Blob(['hello'])), /Not a ZIP/);
});
