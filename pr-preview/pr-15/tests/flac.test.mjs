// FlacEncoder: lossless at 16 bits. Decoded with ffmpeg when it is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlacEncoder } from '../js/flac.js';

let ffmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpeg = true; } catch { /* not installed */ }

// What the encoder stores: round(x * 32768), clamped to 16 bits.
const q16 = (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32768)));

function signals(n) {
  const L = new Float32Array(n), R = new Float32Array(n);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < n; i++) {
    // Tone + noise, a silent stretch (CONSTANT subframes), and clipping.
    const t = i / 44100;
    L[i] = i > 20000 && i < 30000 ? 0 : 0.5 * Math.sin(2 * Math.PI * 440 * t) + 0.05 * rnd();
    R[i] = i > 40000 && i < 41000 ? 1.5 : 0.3 * Math.sin(2 * Math.PI * 660 * t) + 0.3 * L[i];
  }
  return [L, R];
}

async function decode(blob, channels) {
  const dir = mkdtempSync(join(tmpdir(), 'flactest-'));
  writeFileSync(join(dir, 'a.flac'), new Uint8Array(await blob.arrayBuffer()));
  execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'a.flac'), '-f', 's16le', '-acodec', 'pcm_s16le', join(dir, 'a.raw')]);
  const raw = readFileSync(join(dir, 'a.raw'));
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  return Array.from({ length: channels }, (_, c) => pcm.filter((_, i) => i % channels === c));
}

test('header: fLaC + STREAMINFO with rate, channels and sample count', async () => {
  const enc = new FlacEncoder(48000, 1);
  enc.push([new Float32Array(10000)]);
  const b = new Uint8Array(await enc.finish().arrayBuffer());
  assert.equal(new TextDecoder().decode(b.subarray(0, 4)), 'fLaC');
  const si = b.subarray(8, 42);
  const rate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
  const channels = ((si[12] >> 1) & 7) + 1;
  const total = ((si[13] & 15) * 2 ** 32) + ((si[14] << 24) >>> 0) + (si[15] << 16) + (si[16] << 8) + si[17];
  assert.deepEqual([rate, channels, total], [48000, 1, 10000]);
  // A silent stem must be tiny (CONSTANT subframes).
  assert.ok(b.length < 200, `${b.length} bytes for silence`);
});

test('stereo is bit-exact (decoded by ffmpeg)', { skip: !ffmpeg && 'ffmpeg not installed' }, async () => {
  const [L, R] = signals(100000);
  const enc = new FlacEncoder(44100, 2);
  // Odd chunk sizes, so blocks straddle push() calls.
  for (let i = 0; i < L.length; i += 7777) enc.push([L.subarray(i, i + 7777), R.subarray(i, i + 7777)]);
  const [dl, dr] = await decode(enc.finish(), 2);
  assert.equal(dl.length, L.length);
  for (let i = 0; i < L.length; i++) {
    if (dl[i] !== q16(L[i]) || dr[i] !== q16(R[i])) assert.fail(`sample ${i}: ${dl[i]},${dr[i]} vs ${q16(L[i])},${q16(R[i])}`);
  }
});

test('mono is bit-exact (decoded by ffmpeg)', { skip: !ffmpeg && 'ffmpeg not installed' }, async () => {
  const [L] = signals(9000); // shorter than three blocks, ends mid-block
  const enc = new FlacEncoder(44100, 1);
  enc.push([L]);
  const [d] = await decode(enc.finish(), 1);
  assert.deepEqual([...d], [...L].map(q16));
});
