// Pitch-preserving time stretch (WSOLA — waveform-similarity overlap-add,
// the same family of algorithm SoundTouch uses).
//
// The signal is rebuilt from ~40 ms sequences taken from the input at a rate
// scaled by `speed`; each sequence is aligned to the previous output by
// searching ±12 ms for the best waveform match, then crossfaded over 10 ms.
// Alignment is searched on a mono mixdown and applied to all channels so
// stereo stays coherent.

// Stretch `channels` by tempo factor `speed` (0.5 = half tempo, twice as
// long; pitch unchanged). Returns new Float32Arrays of ~inLen/speed samples.
export function wsolaStretch(channels, sampleRate, speed, onProgress) {
  const inLen = channels[0].length;
  const nch = channels.length;
  const outLen = Math.max(1, Math.round(inLen / speed));
  const seq = Math.round(0.040 * sampleRate);
  const overlap = Math.round(0.010 * sampleRate);
  const seek = Math.round(0.012 * sampleRate);
  const flat = seq - overlap;

  if (Math.abs(speed - 1) < 1e-6 || inLen <= seq * 2) {
    return channels.map((c) => c.slice());
  }

  // Zero-pad by one window so sequences can start right up to the end of the
  // input and the output reaches its full length.
  const padLen = inLen + seq + seek;
  const inp = channels.map((c) => {
    const p = new Float32Array(padLen);
    p.set(c);
    return p;
  });
  const out = channels.map(() => new Float32Array(outLen + seq));
  const mono = new Float32Array(padLen);
  for (const c of channels) {
    for (let i = 0; i < inLen; i++) mono[i] += c[i];
  }

  // Correlation of input at `off` against the current output tail.
  const tail = new Float32Array(overlap);
  const score = (off) => {
    let dot = 0, norm = 0;
    for (let i = 0; i < overlap; i += 2) {
      const m = mono[off + i];
      dot += m * tail[i];
      norm += m * m;
    }
    return norm > 1e-9 ? dot / Math.sqrt(norm) : dot;
  };

  // First sequence: straight copy.
  for (let ch = 0; ch < nch; ch++) out[ch].set(inp[ch].subarray(0, seq));
  let outPos = seq;
  let iter = 0;

  while (outPos < outLen) {
    const base = Math.round((outPos - overlap) * speed);
    const lo = Math.max(0, Math.min(base - seek, padLen - seq));
    const hi = Math.min(padLen - seq, base + seek);
    if (hi < lo) break; // safety; unreachable with padding

    for (let i = 0; i < overlap; i++) {
      let v = 0;
      for (let ch = 0; ch < nch; ch++) v += out[ch][outPos - overlap + i];
      tail[i] = v;
    }

    // Coarse scan, then refine around the best candidate.
    let best = lo, bestScore = -Infinity;
    for (let d = lo; d <= hi; d += 4) {
      const sc = score(d);
      if (sc > bestScore) { bestScore = sc; best = d; }
    }
    for (let d = Math.max(lo, best - 3); d <= Math.min(hi, best + 3); d++) {
      if ((d - lo) % 4 === 0) continue;
      const sc = score(d);
      if (sc > bestScore) { bestScore = sc; best = d; }
    }

    for (let ch = 0; ch < nch; ch++) {
      const o = out[ch], inC = inp[ch];
      for (let i = 0; i < overlap; i++) {
        const w = i / overlap;
        const oi = outPos - overlap + i;
        o[oi] = o[oi] * (1 - w) + inC[best + i] * w;
      }
      o.set(inC.subarray(best + overlap, best + seq), outPos);
    }
    outPos += flat;
    if (onProgress && (++iter & 63) === 0) onProgress(Math.min(1, outPos / outLen));
  }

  return out.map((o) => o.slice(0, Math.min(outPos, outLen)));
}

// Runs wsolaStretch in a module Worker (falls back to the main thread when
// workers are unavailable). One job at a time per Player is expected, but
// concurrent jobs are handled via ids.
export class Stretcher {
  constructor() {
    this.worker = null;
    this.jobs = new Map();
    this.nextId = 1;
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./stretch-worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => {
          const { jobId, progress, channels, error } = e.data;
          const job = this.jobs.get(jobId);
          if (!job) return;
          if (progress !== undefined) {
            job.onProgress?.(progress);
            return;
          }
          this.jobs.delete(jobId);
          if (error) job.reject(new Error(error));
          else job.resolve(channels);
        };
      } catch {
        this.worker = null;
      }
    }
  }

  // channels are transferred to the worker; pass copies, not live buffers.
  stretch(channels, sampleRate, speed, onProgress) {
    if (!this.worker) {
      return Promise.resolve(wsolaStretch(channels, sampleRate, speed, onProgress));
    }
    return new Promise((resolve, reject) => {
      const jobId = this.nextId++;
      this.jobs.set(jobId, { resolve, reject, onProgress });
      this.worker.postMessage({ jobId, channels, sampleRate, speed }, channels.map((c) => c.buffer));
    });
  }
}
