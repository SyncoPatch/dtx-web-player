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
