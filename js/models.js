// Separation models (ONNX graphs made by tools/msst-onnx/export.py), kept in
// the Origin Private File System: models/<role>/model.onnx + manifest.json.
// One model per role:
//   drums   — extracts the drum stem from a full mix (needs a "drums" stem)
//   drumsep — splits a drum stem into kick / snare / toms / hh / ride / crash
//
// Writes happen in a worker (separate-worker.js) because the synchronous
// OPFS access handle is the one write API every browser has; reads and
// deletes work from the page.

export const ROLES = {
  drums: 'Drums extractor',
  drumsep: 'Drum splitter',
};

// Canonical drum component names, for whatever the model's config calls them.
const STEM_ALIASES = {
  kick: ['kick', 'kicks', 'bd', 'bassdrum', 'bass drum'],
  snare: ['snare', 'snares', 'sd'],
  toms: ['toms', 'tom'],
  hh: ['hh', 'hihat', 'hi-hat', 'hi_hat', 'hihats', 'hi-hats'],
  ride: ['ride', 'rides'],
  crash: ['crash', 'crashes'],
  cymbals: ['cymbals', 'cymbal', 'cym'],
};
const ALIAS = new Map(Object.entries(STEM_ALIASES).flatMap(([k, v]) => v.map((a) => [a, k])));

export function canonicalStem(name) {
  return ALIAS.get(String(name).trim().toLowerCase()) ?? null;
}

// Throws a readable error unless m is a usable manifest.
export function validateManifest(m) {
  const bad = (msg) => { throw new Error(`Not a separation model manifest: ${msg}`); };
  if (!m || typeof m !== 'object') bad('not JSON object');
  if (m.format !== 1) bad(`unknown format ${m.format}`);
  if (!ROLES[m.role]) bad(`unknown role "${m.role}"`);
  if (!(m.chunk > 0) || !(m.sampleRate > 0) || !(m.overlap >= 1)) bad('missing chunk / sampleRate / overlap');
  if (!Array.isArray(m.stems) || !m.stems.length) bad('no stems');
  if (m.role === 'drums' && !m.stems.includes('drums')) bad('a drums extractor needs a "drums" stem');
  if (m.role === 'drumsep') {
    const have = new Set(m.stems.map(canonicalStem));
    if (!have.has('kick') || !have.has('snare')) {
      bad(`a drum splitter needs at least kick and snare stems (has ${m.stems.join(', ')})`);
    }
  }
  return m;
}

export function opfsAvailable() {
  return !!navigator.storage?.getDirectory;
}

async function modelsDir(create = false) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('models', { create });
}

// { drums: { manifest, size } | null, drumsep: … }
export async function listModels() {
  const out = { drums: null, drumsep: null };
  if (!opfsAvailable()) return out;
  let dir;
  try { dir = await modelsDir(); } catch { return out; }
  for (const role of Object.keys(ROLES)) {
    try {
      const d = await dir.getDirectoryHandle(role);
      const manifest = JSON.parse(await (await (await d.getFileHandle('manifest.json')).getFile()).text());
      const file = await (await d.getFileHandle('model.onnx')).getFile();
      // A partial install (interrupted download) has no "complete" marker.
      if (manifest.complete && file.size === manifest.bytes) out[role] = { manifest, size: file.size };
    } catch { /* not installed */ }
  }
  return out;
}

export async function removeModel(role) {
  try {
    const dir = await modelsDir();
    await dir.removeEntry(role, { recursive: true });
  } catch (err) {
    if (err?.name !== 'NotFoundError') throw err;
  }
}

// Install from picked files: one .json manifest plus its .onnx (pairs by base
// name; several pairs at once are fine). Resolves to the installed roles.
export async function installFromFiles(files, { onProgress, signal } = {}) {
  const list = [...files];
  const jsons = list.filter((f) => /\.json$/i.test(f.name));
  if (!jsons.length) throw new Error('Pick the model\'s .json manifest together with its .onnx file.');
  const jobs = [];
  for (const j of jsons) {
    const base = j.name.replace(/\.json$/i, '');
    const onnx = list.find((f) => f.name === base + '.onnx') ||
      (jsons.length === 1 ? list.find((f) => /\.onnx$/i.test(f.name)) : null);
    if (!onnx) throw new Error(`No ${base}.onnx next to ${j.name}.`);
    let manifest;
    try { manifest = JSON.parse(await j.text()); } catch { throw new Error(`${j.name} is not valid JSON.`); }
    jobs.push({ manifest: validateManifest(manifest), source: onnx });
  }
  return runInstall(jobs, { onProgress, signal });
}

// Install from a URL to the .json manifest; the .onnx is expected next to it
// (same base name), e.g. on a Hugging Face repo. The host must allow CORS.
export async function installFromUrl(url, { onProgress, signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Manifest download failed (HTTP ${res.status}).`);
  let manifest;
  try { manifest = await res.json(); } catch { throw new Error('The URL did not return a JSON manifest.'); }
  validateManifest(manifest);
  const onnxUrl = new URL(url.replace(/\.json(\?.*)?$/i, '.onnx$1'), location.href).href;
  return runInstall([{ manifest, source: onnxUrl }], { onProgress, signal });
}

async function runInstall(jobs, { onProgress, signal }) {
  if (!opfsAvailable()) throw new Error('This browser has no private file storage (OPFS) for models.');
  navigator.storage.persist?.().catch(() => {});
  await modelsDir(true);
  const worker = new Worker(new URL('./separate-worker.js', import.meta.url), { type: 'module' });
  try {
    const roles = [];
    for (let i = 0; i < jobs.length; i++) {
      const { manifest, source } = jobs[i];
      await removeModel(manifest.role);
      await new Promise((resolve, reject) => {
        const stop = () => { worker.terminate(); reject(new DOMException('Install cancelled', 'AbortError')); };
        if (signal?.aborted) { stop(); return; }
        signal?.addEventListener('abort', stop, { once: true });
        worker.onmessage = (e) => {
          const { progress, done, error } = e.data;
          if (progress !== undefined) { onProgress?.((i + progress) / jobs.length, manifest); return; }
          signal?.removeEventListener('abort', stop);
          if (error) reject(new Error(error));
          else if (done) resolve();
        };
        worker.onerror = (e) => {
          signal?.removeEventListener('abort', stop);
          reject(new Error(e.message || 'The model install worker failed.'));
        };
        worker.postMessage({ cmd: 'install', manifest, source });
      }).catch(async (err) => {
        await removeModel(manifest.role).catch(() => {});
        throw err;
      });
      roles.push(manifest.role);
    }
    return roles;
  } finally {
    worker.terminate();
  }
}
