// createZip: read back by our own extractZip and by Python's zipfile (CRC check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip } from '../js/zipwrite.js';
import { extractZip } from '../js/zip.js';

const bytes = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
const ENTRIES = [
  { name: 'Song/chart.dtx', data: new TextEncoder().encode('#TITLE: x\n') },
  { name: 'Song/音/キック.wav', data: bytes(70000, 3) }, // UTF-8 names
  { name: 'Song/empty.txt', data: new Uint8Array(0) },
];

test('round-trips through extractZip', async () => {
  const zip = await createZip(ENTRIES.map((e) => ({ name: e.name, blob: new Blob([e.data]) })));
  assert.equal(zip.type, 'application/zip');
  const out = await extractZip(zip);
  assert.deepEqual(out.map((e) => e.name), ENTRIES.map((e) => e.name));
  for (let i = 0; i < ENTRIES.length; i++) {
    assert.deepEqual(new Uint8Array(await out[i].blob.arrayBuffer()), ENTRIES[i].data);
  }
});

test('Python zipfile accepts it (names, sizes, CRCs)', async () => {
  const zip = await createZip(ENTRIES.map((e) => ({ name: e.name, blob: new Blob([e.data]) })));
  const dir = mkdtempSync(join(tmpdir(), 'zipw-'));
  const path = join(dir, 'a.zip');
  writeFileSync(path, new Uint8Array(await zip.arrayBuffer()));
  const py = 'import sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({"bad":z.testzip(),"names":z.namelist(),"sizes":[i.file_size for i in z.infolist()]}))';
  const r = JSON.parse(execFileSync('python3', ['-I', '-c', py, path]).toString());
  assert.equal(r.bad, null);
  assert.deepEqual(r.names, ENTRIES.map((e) => e.name));
  assert.deepEqual(r.sizes, ENTRIES.map((e) => e.data.length));
});

async function pythonRead(zip) {
  const dir = mkdtempSync(join(tmpdir(), 'zipw-'));
  const path = join(dir, 'a.zip');
  writeFileSync(path, new Uint8Array(await zip.arrayBuffer()));
  const py = 'import sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({"bad":z.testzip(),"n":len(z.infolist()),"names":z.namelist()[:3],"sizes":[i.file_size for i in z.infolist()][:3]}))';
  return JSON.parse(execFileSync('python3', ['-I', '-c', py, path], { maxBuffer: 1 << 26 }).toString());
}

test('Zip64 records (forced) read back by extractZip and Python', async () => {
  const zip = await createZip(ENTRIES.map((e) => ({ name: e.name, blob: new Blob([e.data]) })), { forceZip64: true });
  const out = await extractZip(zip);
  assert.deepEqual(out.map((e) => e.name), ENTRIES.map((e) => e.name));
  for (let i = 0; i < ENTRIES.length; i++) {
    assert.deepEqual(new Uint8Array(await out[i].blob.arrayBuffer()), ENTRIES[i].data);
  }
  const r = await pythonRead(zip);
  assert.equal(r.bad, null);
  assert.deepEqual(r.names, ENTRIES.map((e) => e.name));
  assert.deepEqual(r.sizes, ENTRIES.map((e) => e.data.length));
});

test('more than 65535 entries', async () => {
  const N = 70000;
  const one = new Blob([new Uint8Array([7])]);
  const entries = Array.from({ length: N }, (_, i) => ({ name: `d/${i}.txt`, blob: one }));
  const zip = await createZip(entries);
  const out = await extractZip(zip);
  assert.equal(out.length, N);
  assert.equal(out[N - 1].name, `d/${N - 1}.txt`);
  const r = await pythonRead(zip);
  assert.equal(r.bad, null);
  assert.equal(r.n, N);
});
