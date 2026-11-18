// Runs the alignment (align-core.js) off the main thread.
import { onsetFeatures, alignBars } from './align-core.js';

self.onmessage = (e) => {
  const { samples, notes, scoreTimes, pins } = e.data;
  try {
    let last = -1;
    const report = (p) => {
      const pct = Math.round(p * 100);
      if (pct !== last) { last = pct; self.postMessage({ progress: p }); }
    };
    const features = onsetFeatures(samples, (p) => report(0.4 * p));
    const result = alignBars(features, notes, scoreTimes, { pins, onProgress: (p) => report(0.4 + 0.6 * p) });
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};
