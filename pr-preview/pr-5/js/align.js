// Automatic alignment of a Guitar Pro chart to its recording: prepares the
// audio and the chart's notes, runs align-core.js in a Worker, and returns
// the audio time of every measure start (see gpsync.js).

import { barSegments, scoreBarTimes } from './gpsync.js';

// How strongly each drum shows up in the low / mid / high onset bands.
const BAND_WEIGHTS = new Map([
  [0x13, [1, 0.2, 0]],     // kick
  [0x12, [0.2, 1, 0.6]],   // snare
  [0x14, [0.4, 0.8, 0]],   // high tom
  [0x15, [0.6, 0.7, 0]],   // low tom
  [0x17, [0.8, 0.5, 0]],   // floor tom
  [0x11, [0, 0.1, 0.8]],   // closed hi-hat
  [0x18, [0, 0.2, 1]],     // open hi-hat
  [0x1B, [0, 0.1, 0.5]],   // pedal hi-hat
  [0x16, [0.2, 0.5, 1]],   // crash
  [0x1A, [0.2, 0.5, 1]],   // left crash
  [0x19, [0, 0.2, 0.6]],   // ride
]);

// The chart's notes as { bar, frac, w }: frac is the note's position in its
// measure as a fraction of the measure's score duration.
export function alignNotes(model) {
  const segs = barSegments(model);
  const notes = [];
  model.bars.forEach((bar, b) => {
    const s = segs[b];
    const secAt = (tick) => {
      let t = 0;
      for (let j = 0; j < s.length; j++) {
        const end = j + 1 < s.length ? s[j + 1].tick : bar.ticks;
        if (tick <= s[j].tick) break;
        t += ((Math.min(tick, end) - s[j].tick) / model.division) * 60 / s[j].bpm;
      }
      return t;
    };
    const len = secAt(bar.ticks);
    const seen = new Set();
    for (const n of bar.notes) {
      const w = BAND_WEIGHTS.get(n.ch);
      if (!w || seen.has(n.ch + ':' + n.tick)) continue;
      seen.add(n.ch + ':' + n.tick);
      notes.push({ bar: b, frac: secAt(n.tick) / len, w });
    }
  });
  return notes;
}

// Mono, resampled to the analysis rate.
async function prepareAudio(buffer, sr) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, Math.max(1, Math.ceil(buffer.duration * sr)), sr);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0);
  return (await ctx.startRendering()).getChannelData(0);
}

// buffer: the decoded recording. pins: [{ bar, time }]. signal: AbortSignal.
// Resolves to alignBars' result (barTimes, confidence, overall, method, …).
export async function alignRecording(buffer, model, { pins = [], onProgress, signal } = {}) {
  const { SR } = await import('./align-core.js');
  onProgress?.(0);
  const samples = await prepareAudio(buffer, SR);
  if (signal?.aborted) throw new DOMException('Alignment cancelled', 'AbortError');
  const job = { samples, notes: alignNotes(model), scoreTimes: scoreBarTimes(model), pins };

  let worker = null;
  try {
    worker = new Worker(new URL('./align-worker.js', import.meta.url), { type: 'module' });
  } catch { /* no module workers: run here */ }
  if (!worker) {
    const { onsetFeatures, alignBars } = await import('./align-core.js');
    const features = onsetFeatures(job.samples, (p) => onProgress?.(0.4 * p));
    return alignBars(features, job.notes, job.scoreTimes, { pins, onProgress: (p) => onProgress?.(0.4 + 0.6 * p) });
  }

  return new Promise((resolve, reject) => {
    const stop = () => {
      worker.terminate();
      reject(new DOMException('Alignment cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', stop, { once: true });
    worker.onmessage = (e) => {
      const { progress, result, error } = e.data;
      if (progress !== undefined) { onProgress?.(progress); return; }
      signal?.removeEventListener('abort', stop);
      worker.terminate();
      if (error) reject(new Error(error));
      else resolve(result);
    };
    worker.onerror = (e) => {
      signal?.removeEventListener('abort', stop);
      worker.terminate();
      reject(new Error(e.message || 'The alignment worker failed.'));
    };
    worker.postMessage(job, [job.samples.buffer]);
  });
}
