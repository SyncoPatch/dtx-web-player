// Drum separation of a recording, driven from the page: resamples the
// decoded recording to the models' rate and runs separate-worker.js.
// Resolves to { files: { nodrums, kick, snare, … }: Blob, backend, seconds, models }.

import { listModels } from './models.js';

export const STEM_DIR = 'stems/';

// Stereo at the given rate (mono recordings are duplicated by the mixer).
async function prepareAudio(buffer, sr) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(2, Math.max(1, Math.ceil(buffer.duration * sr)), sr);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0);
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

// onProgress(fraction, phase?) — phase is a label when the stage changes.
export async function separateRecording(buffer, { onProgress, signal } = {}) {
  const models = await listModels();
  if (!models.drums || !models.drumsep) throw new Error('Install both separation models first (Settings).');
  const sr = models.drums.manifest.sampleRate;
  onProgress?.(0, 'Preparing audio');
  const mix = await prepareAudio(buffer, sr);
  if (signal?.aborted) throw new DOMException('Separation cancelled', 'AbortError');

  const worker = new Worker(new URL('./separate-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const stop = () => {
      worker.terminate();
      reject(new DOMException('Separation cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', stop, { once: true });
    const finish = () => {
      signal?.removeEventListener('abort', stop);
      worker.terminate();
    };
    worker.onmessage = (e) => {
      const { progress, phase, stats, result, error } = e.data;
      if (progress !== undefined) { onProgress?.(progress, phase, stats); return; }
      finish();
      if (error) reject(new Error(error));
      else resolve(result);
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message || 'The separation worker failed.'));
    };
    worker.postMessage({ cmd: 'separate', mix, sampleRate: sr }, [mix[0].buffer, mix[1].buffer]);
  });
}
