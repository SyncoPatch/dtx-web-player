// Off-main-thread work for drum separation:
//
//  { cmd: 'install', manifest, source: File | url }
//      streams a model into OPFS (models/<role>/), then writes its manifest
//      with { complete: true, bytes } so half-written installs are ignored.
//  { cmd: 'separate', mix: [Float32Array, Float32Array], sampleRate }
//      pass 1: drums extractor -> drum stem; backing = mix - drums (stereo)
//      pass 2: drum splitter on the drum stem -> one mono file per component
//      replies { result: { files: { nodrums, kick, snare, … }: Blob, backend, seconds } }
//      Each stem is encoded as Ogg Opus and as FLAC in the same pass, and
//      the smaller file is kept: Opus wins on dense audio, while FLAC can
//      beat Opus' fixed bitrate on a nearly silent stem.
//
// Progress is posted as { progress, phase }; failures as { error }.
// Cancelling = the page terminates this worker.

import { demix } from './separate-core.js';
import { FlacEncoder } from './flac.js';
import { OpusOggEncoder } from './ogg.js';
import { canonicalStem } from './models.js';

// Opus bitrates (bits/s): the stereo backing track, the mono drum stems.
const BACKING_BPS = 160000;
const STEM_BPS = 96000;

class StemEncoder {
  constructor(sampleRate, channels, opusBps) {
    this.flac = new FlacEncoder(sampleRate, channels);
    this.opus = opusBps ? new OpusOggEncoder(sampleRate, channels, opusBps) : null;
  }

  push(chans) {
    this.flac.push(chans);
    if (this.opus) {
      try { this.opus.push(chans); } catch (err) { console.warn('Opus encoding failed:', err); this.opus = null; }
    }
  }

  async finish() {
    const flac = this.flac.finish();
    if (!this.opus) return flac;
    try {
      const ogg = await this.opus.finish();
      return ogg.size < flac.size ? ogg : flac;
    } catch (err) {
      console.warn('Opus encoding failed:', err);
      return flac;
    }
  }
}

async function makeEncoder(sampleRate, channels, bps) {
  return new StemEncoder(sampleRate, channels, (await OpusOggEncoder.supported(channels, bps)) ? bps : 0);
}

// Progress labels say where the model runs, since the CPU path is ~3-7x slower.
const ON = { webgpu: 'on the GPU', wasm: 'on the CPU, slow' };
let phaseLabel = '';

let lastPct = -1;
function report(progress, phase, stats) {
  const pct = Math.floor(progress * 1000);
  if (pct === lastPct && !phase && !stats) return;
  lastPct = pct;
  self.postMessage({ progress, phase, stats });
}

// Per-pass timing: wall time per chunk (model + chunk bookkeeping + encoding)
// next to the model's share, shown in the progress line.
let timing = null;
function startTiming() {
  timing = { t0: performance.now(), model: 0, chunks: 0 };
}
function chunkDone(progress) {
  timing.chunks++;
  const wall = (performance.now() - timing.t0) / 1000 / timing.chunks;
  const model = timing.model / 1000 / timing.chunks;
  const stats = `${wall.toFixed(1)} s per chunk (model ${model.toFixed(1)} s)`;
  if (timing.chunks % 10 === 1) console.info(`separation: chunk ${timing.chunks}, ${stats}`);
  report(progress, undefined, stats);
}

async function roleDir(role, create = false) {
  const root = await navigator.storage.getDirectory();
  const models = await root.getDirectoryHandle('models', { create });
  return models.getDirectoryHandle(role, { create });
}

async function writeFile(dir, name, chunks, total, onBytes) {
  const fh = await dir.getFileHandle(name, { create: true });
  const h = await fh.createSyncAccessHandle();
  let pos = 0;
  try {
    h.truncate(0);
    for await (const chunk of chunks) {
      h.write(chunk, { at: pos });
      pos += chunk.byteLength;
      onBytes?.(pos, total);
    }
    h.flush();
  } finally {
    h.close();
  }
  return pos;
}

async function* readerChunks(stream) {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

async function install({ manifest, source }) {
  const dir = await roleDir(manifest.role, true);
  let stream;
  let total;
  if (typeof source === 'string') {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Model download failed (HTTP ${res.status}).`);
    total = Number(res.headers.get('content-length')) || 0;
    stream = res.body;
  } else {
    total = source.size;
    stream = source.stream();
  }
  const bytes = await writeFile(dir, 'model.onnx', readerChunks(stream), total,
    (pos, t) => report(t ? Math.min(0.99, pos / t) : 0));
  if (bytes < 1024) throw new Error('The model file is empty or truncated.');
  const json = new TextEncoder().encode(JSON.stringify({ ...manifest, complete: true, bytes }));
  await writeFile(dir, 'manifest.json', [json]);
  self.postMessage({ done: true });
}

// ---------------------------------------------------------------------------

async function loadOrt() {
  const ort = await import('./vendor/onnxruntime/ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = new URL('./vendor/onnxruntime/', import.meta.url).href;
  // Multi-threaded WASM needs cross-origin isolation, which GitHub Pages
  // can't provide; WebGPU does the heavy lifting anyway.
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  return ort;
}

async function openSession(ort, role) {
  const dir = await roleDir(role);
  const manifest = JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text());
  const bytes = new Uint8Array(await (await (await dir.getFileHandle('model.onnx')).getFile()).arrayBuffer());
  let session = null;
  let backend = 'webgpu';
  if (self.navigator.gpu) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
    } catch (err) {
      console.warn('WebGPU session failed, falling back to WASM:', err);
    }
  }
  if (!session) {
    backend = 'wasm';
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  }
  const C = manifest.chunk;
  const S = manifest.stems.length;
  const h = { session, manifest, backend, run: null };
  const once = async (input) => {
    const feeds = { [h.session.inputNames[0]]: new ort.Tensor('float32', input, [1, 2, C]) };
    const t = performance.now();
    const out = (await h.session.run(feeds))[h.session.outputNames[0]];
    if (timing) timing.model += performance.now() - t;
    const data = out.data;
    if (data.length !== S * 2 * C) {
      throw new Error(`${manifest.name}: model returned ${data.length} values, expected ${S}×2×${C}.`);
    }
    return data;
  };
  // A WebGPU session can be created and still fail on its first run (e.g. a
  // shader the browser can't compile): fall back to WASM and retry.
  h.run = async (input) => {
    try {
      return await once(input);
    } catch (err) {
      if (h.backend !== 'webgpu') throw err;
      console.warn('WebGPU run failed, falling back to WASM:', err);
      if (phaseLabel) report(lastPct / 1000, `${phaseLabel} (${ON.wasm}: WebGPU failed)`);
      await h.session.release().catch(() => {});
      h.session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      h.backend = 'wasm';
      return once(input);
    }
  };
  return h;
}

async function separate({ mix, sampleRate }) {
  const t0 = performance.now();
  report(0, 'Loading models');
  const ort = await loadOrt();

  // Pass 1: drums out of the mix; the backing track is what's left.
  const ex = await openSession(ort, 'drums');
  if (ex.manifest.sampleRate !== sampleRate) throw new Error('Sample rate mismatch with the drums extractor.');
  const n = mix[0].length;
  const drums = [new Float32Array(n), new Float32Array(n)];
  const di = ex.manifest.stems.indexOf('drums');
  const backing = await makeEncoder(sampleRate, 2, BACKING_BPS);
  phaseLabel = 'Extracting drums';
  report(0, `${phaseLabel} (${ON[ex.backend]}${self.navigator.gpu ? '' : ': no WebGPU in workers here'})`);
  startTiming();
  await demix(mix, ex.manifest, ex.run, {
    onOutput(pos, blocks) {
      const [l, r] = blocks[di];
      drums[0].set(l, pos);
      drums[1].set(r, pos);
      const bl = new Float32Array(l.length);
      const br = new Float32Array(l.length);
      for (let i = 0; i < l.length; i++) {
        bl[i] = mix[0][pos + i] - l[i];
        br[i] = mix[1][pos + i] - r[i];
      }
      backing.push([bl, br]);
    },
    onProgress: (p) => chunkDone(0.5 * p),
  });
  await ex.session.release();
  const files = { nodrums: await backing.finish() };
  mix = null;

  // Pass 2: split the drum stem into components (mono keysound sources).
  const sp = await openSession(ort, 'drumsep');
  if (sp.manifest.sampleRate !== sampleRate) {
    throw new Error('The two models use different sample rates; export both at the same rate.');
  }
  const names = sp.manifest.stems.map(canonicalStem);
  const encoders = [];
  for (let i = 0; i < names.length; i++) {
    encoders.push(names[i] && names.indexOf(names[i]) === i ? await makeEncoder(sampleRate, 1, STEM_BPS) : null);
  }
  phaseLabel = 'Splitting drums';
  report(0.5, `${phaseLabel} (${ON[sp.backend]})`);
  startTiming();
  await demix(drums, sp.manifest, sp.run, {
    onOutput(pos, blocks) {
      blocks.forEach(([l, r], s) => {
        const enc = encoders[s];
        if (!enc) return;
        const mono = new Float32Array(l.length);
        for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2;
        enc.push([mono]);
      });
    },
    onProgress: (p) => chunkDone(0.5 + 0.5 * p),
  });
  await sp.session.release();
  report(1, 'Encoding');
  for (let s = 0; s < encoders.length; s++) if (encoders[s]) files[names[s]] = await encoders[s].finish();

  const backend = ex.backend === sp.backend ? ex.backend : `${ex.backend}+${sp.backend}`;
  self.postMessage({
    result: {
      files,
      backend,
      seconds: (performance.now() - t0) / 1000,
      models: [ex.manifest.name, sp.manifest.name],
    },
  });
}

self.onmessage = async (e) => {
  try {
    if (e.data.cmd === 'install') await install(e.data);
    else if (e.data.cmd === 'separate') await separate(e.data);
    else throw new Error(`Unknown command ${e.data.cmd}`);
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};
