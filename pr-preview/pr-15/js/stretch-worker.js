import { wsolaStretch } from './stretch.js';

self.onmessage = (e) => {
  const { jobId, channels, sampleRate, speed } = e.data;
  try {
    let lastSent = 0;
    const out = wsolaStretch(channels, sampleRate, speed, (p) => {
      const now = Date.now();
      if (now - lastSent > 100) { // throttle progress messages
        lastSent = now;
        self.postMessage({ jobId, progress: p });
      }
    });
    self.postMessage({ jobId, channels: out }, out.map((a) => a.buffer));
  } catch (err) {
    self.postMessage({ jobId, error: String(err?.message || err) });
  }
};
