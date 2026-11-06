// Off-main-thread work for drum separation:
//
//  { cmd: 'install', manifest, source: File | url }
//      streams a model into OPFS (models/<role>/), then writes its manifest
//      with { complete: true, bytes } so half-written installs are ignored.
//  { cmd: 'separate', mix: [Float32Array, Float32Array], sampleRate }
//      pass 1: drums extractor -> drum stem; backing = mix - drums (FLAC, stereo)
//      pass 2: drum splitter on the drum stem -> one mono FLAC per component
//      replies { result: { files: { nodrums, kick, snare, … }: Blob, backend, seconds } }
//
// Progress is posted as { progress, phase }; failures as { error }.
// Cancelling = the page terminates this worker.

import { demix } from './separate-core.js';
import { FlacEncoder } from './flac.js';
import { canonicalStem } from './models.js';

let lastPct = -1;
function report(progress, phase) {
  const pct = Math.floor(progress * 1000);
  if (pct === lastPct && !phase) return;
  lastPct = pct;
  self.postMessage({ progress, phase });
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
  const run = async (input) => {
    const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 2, C]) };
    const out = (await session.run(feeds))[session.outputNames[0]];
    const data = out.data;
    if (data.length !== S * 2 * C) {
      throw new Error(`${manifest.name}: model returned ${data.length} values, expected ${S}×2×${C}.`);
    }
    return data;
  };
  return { session, manifest, backend, run };
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
  const backing = new FlacEncoder(sampleRate, 2);
  report(0, 'Extracting drums');
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
    onProgress: (p) => report(0.5 * p),
  });
  await ex.session.release();
  const files = { nodrums: backing.finish() };
  mix = null;

  // Pass 2: split the drum stem into components (mono keysound sources).
  const sp = await openSession(ort, 'drumsep');
  if (sp.manifest.sampleRate !== sampleRate) {
    throw new Error('The two models use different sample rates; export both at the same rate.');
  }
  const names = sp.manifest.stems.map(canonicalStem);
  const encoders = names.map((name, i) => (name && names.indexOf(name) === i ? new FlacEncoder(sampleRate, 1) : null));
  report(0.5, 'Splitting drums');
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
    onProgress: (p) => report(0.5 + 0.5 * p),
  });
  await sp.session.release();
  encoders.forEach((enc, s) => { if (enc) files[names[s]] = enc.finish(); });

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
