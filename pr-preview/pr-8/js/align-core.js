// Aligns a chart to a recording of it. Pure functions, used from a Worker
// (align-worker.js) and from tests.
//
// 1. onsetFeatures: onset strength of the recording in three bands
//    (low ≈ kick, mid ≈ snare/toms, high ≈ cymbals), one value per 5.8 ms.
// 2. alignBars: finds when every measure starts in the recording.
//    a) global search: the tempo scale and offset that best match the whole
//       chart (FFT cross-correlation over a range of scales);
//    b) tracking: a per-measure Viterbi search around that line that lets
//       the tempo drift, scoring each measure's notes against the audio;
//    c) refinement of the same search at full resolution;
//    d) if one straight line fits as well (click-tracked recordings), use it.

export const SR = 22050;
export const HOP = 128;
const WIN = 1024;
const BANDS = [[40, 150], [150, 4000], [5000, 11000]];

// ---- FFT (in-place, radix-2, complex) ----

const twiddleCache = new Map();
function twiddles(n) {
  let t = twiddleCache.get(n);
  if (!t) {
    t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
    for (let i = 0; i < n / 2; i++) {
      t.cos[i] = Math.cos(-2 * Math.PI * i / n);
      t.sin[i] = Math.sin(-2 * Math.PI * i / n);
    }
    twiddleCache.set(n, t);
  }
  return t;
}

export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const { cos, sin } = twiddles(n);
  const sgn = inverse ? -1 : 1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const wr = cos[j * step], wi = sgn * sin[j * step];
        const a = i + j, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// ---- 1. onset features ----

function movingMean(x, radius) {
  const out = new Float32Array(x.length);
  let sum = 0, lo = 0, hi = -1;
  for (let i = 0; i < x.length; i++) {
    while (hi < Math.min(x.length - 1, i + radius)) sum += x[++hi];
    while (lo < i - radius) sum -= x[lo++];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

function gaussianSmooth(x, sigma) {
  const r = Math.ceil(sigma * 3);
  const k = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < x.length) s += x[idx] * k[j + r];
    }
    out[i] = s / ks;
  }
  return out;
}

// samples: mono Float32Array at SR. Returns { frame, t0, bands: [Float32Array × 3] }
// of normalized onset strength (≈ z-scores: 0 = typical, higher = onset).
// Value i belongs to time t0 + i * frame: an onset peaks when it reaches the
// middle of the analysis window, so t0 is half a window.
export function onsetFeatures(samples, onProgress) {
  const nFrames = samples.length >= WIN ? Math.floor((samples.length - WIN) / HOP) + 1 : 0;
  const win = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WIN);
  const binHz = SR / WIN;
  const ranges = BANDS.map(([lo, hi]) => [Math.max(1, Math.ceil(lo / binHz)), Math.min(WIN / 2, Math.floor(hi / binHz))]);
  const flux = BANDS.map(() => new Float32Array(nFrames));
  const re = new Float64Array(WIN), im = new Float64Array(WIN);
  const half = WIN / 2 + 1;
  let prev = new Float32Array(half);
  const la = new Float32Array(half), lb = new Float32Array(half);
  const GAMMA = 1000;

  const addFlux = (f, cur, before) => {
    for (let b = 0; b < ranges.length; b++) {
      const [lo, hi] = ranges[b];
      let s = 0;
      for (let k = lo; k <= hi; k++) { const d = cur[k] - before[k]; if (d > 0) s += d; }
      flux[b][f] = s / (hi - lo + 1);
    }
  };

  // Two real frames per complex FFT: frame f in the real part, f+1 in the imaginary.
  for (let f = 0; f < nFrames; f += 2) {
    const o1 = f * HOP, o2 = (f + 1) * HOP, second = f + 1 < nFrames;
    for (let i = 0; i < WIN; i++) {
      re[i] = samples[o1 + i] * win[i];
      im[i] = second ? samples[o2 + i] * win[i] : 0;
    }
    fft(re, im);
    for (let k = 0; k < half; k++) {
      const k2 = (WIN - k) % WIN;
      const ar = (re[k] + re[k2]) / 2, ai = (im[k] - im[k2]) / 2;
      const br = (im[k] + im[k2]) / 2, bi = -(re[k] - re[k2]) / 2;
      la[k] = Math.log1p(GAMMA * Math.hypot(ar, ai));
      lb[k] = Math.log1p(GAMMA * Math.hypot(br, bi));
    }
    addFlux(f, la, prev);
    if (second) { addFlux(f + 1, lb, la); prev.set(lb); } else prev.set(la);
    if (onProgress && (f & 2047) === 0) onProgress(f / nFrames);
  }

  const frame = HOP / SR;
  const bands = flux.map((x) => {
    const mean = movingMean(x, Math.round(0.25 / frame));
    const d = new Float32Array(x.length);
    let ss = 0;
    for (let i = 0; i < x.length; i++) { d[i] = x[i] - mean[i]; ss += d[i] * d[i]; }
    const std = Math.sqrt(ss / Math.max(1, x.length)) || 1;
    for (let i = 0; i < x.length; i++) d[i] = Math.max(-1, Math.min(8, d[i] / std));
    return d;
  });
  return { frame, t0: WIN / 2 / SR, bands };
}

// ---- 2. alignment ----

// Max-pool features by an integer factor, then smooth.
function pool(bands, factor, sigma) {
  return bands.map((x) => {
    const n = Math.floor(x.length / factor);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = -Infinity;
      for (let j = 0; j < factor; j++) m = Math.max(m, x[i * factor + j]);
      out[i] = m;
    }
    return sigma ? gaussianSmooth(out, sigma) : out;
  });
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

// Candidate (scale, offset) pairs with audioTime = offset + scale * scoreTime,
// best first. Outside the recording counts as "no onset" (-1), so a line that
// pushes notes past either end scores worse than one that covers them.
function globalSearch(bands, dt, t0, noteTimes, noteW, onProgress, count = 3) {
  const lenA = bands[0].length;
  const maxScore = noteTimes.length ? noteTimes[noteTimes.length - 1] : 0;
  const scales = [];
  for (let s = 0.8; s <= 1.25 + 1e-9; s += 0.004) scales.push(s);
  const lenY = Math.ceil((maxScore * scales[scales.length - 1]) / dt) + 2;
  const N = nextPow2(lenA + lenY);

  const fa = bands.map((x) => {
    const re = new Float64Array(N).fill(-1), im = new Float64Array(N);
    re.set(x);
    fft(re, im);
    return { re, im };
  });

  const peaks = []; // best few per scale: { score, scale, offset }
  const yr = new Float64Array(N), yi = new Float64Array(N);
  const accR = new Float64Array(N), accI = new Float64Array(N);
  for (let si = 0; si < scales.length; si++) {
    const s = scales[si];
    accR.fill(0); accI.fill(0);
    for (let b = 0; b < bands.length; b++) {
      yr.fill(0); yi.fill(0);
      for (let n = 0; n < noteTimes.length; n++) {
        const w = noteW[n * 3 + b];
        if (w) yr[Math.round((s * noteTimes[n]) / dt)] += w;
      }
      fft(yr, yi);
      // corr(lag) = sum_k A[k + lag] Y[k]  <=>  FFT(A) * conj(FFT(Y))
      const { re: ar, im: ai } = fa[b];
      for (let k = 0; k < N; k++) {
        accR[k] += ar[k] * yr[k] + ai[k] * yi[k];
        accI[k] += ai[k] * yr[k] - ar[k] * yi[k];
      }
    }
    fft(accR, accI, true);
    // Lags 0..lenA-1 are offsets >= 0; N-lenY..N-1 are negative offsets.
    // Keep this scale's best lags that are at least 1 s apart.
    const local = [];
    for (let k = 0; k < N; k++) {
      const lag = k < lenA ? k : k >= N - lenY ? k - N : null;
      if (lag === null) continue;
      const v = accR[k];
      if (local.length === count && v <= local[count - 1].score) continue;
      const offset = t0 + lag * dt;
      const near = local.findIndex((p) => Math.abs(p.offset - offset) < 1);
      if (near >= 0) {
        if (v > local[near].score) local[near] = { score: v, scale: s, offset };
      } else {
        local.push({ score: v, scale: s, offset });
      }
      local.sort((a, b) => b.score - a.score);
      if (local.length > count) local.length = count;
    }
    peaks.push(...local);
    onProgress?.((si + 1) / scales.length);
  }
  // Distinct candidates overall: different offset (1 s) or scale (2%).
  peaks.sort((a, b) => b.score - a.score);
  const out = [];
  for (const p of peaks) {
    if (out.some((q) => Math.abs(q.offset - p.offset) < 1 && Math.abs(q.scale - p.scale) < 0.02)) continue;
    out.push(p);
    if (out.length === count) break;
  }
  return out;
}

// Feature lookup at time t: value i belongs to t0 + i * dt; outside the
// recording counts as "no onset".
function sampler(feat, dt, t0) {
  const n = feat[0].length;
  return (t, w) => {
    const i = Math.round((t - t0) / dt);
    if (i < 0 || i >= n) return -(w[0] + w[1] + w[2]);
    return w[0] * feat[0][i] + w[1] * feat[1][i] + w[2] * feat[2][i];
  };
}

function notesByBar(notes, B) {
  const byBar = Array.from({ length: B }, () => []);
  for (const n of notes) byBar[n.bar].push(n);
  return byBar;
}

// Per-measure Viterbi over bar-start deviations from base[], in steps of dt.
// State d at node b means measure b starts at base[b] + (d - R) * dt. The
// score is the notes' onset evidence minus a penalty on changes of measure
// length (relative to the base), and every step is limited to maxStepFrac
// of a measure. Pins restrict their node to ±0.25 s.
// Returns { times, score }.
function track(feat, dt, t0, byBar, base, R, maxStepFrac, lambda, pins, scoreLen) {
  const B = base.length - 1;
  const S = 2 * R + 1;
  const ev = sampler(feat, dt, t0);
  const allowed = (b, d) => {
    const p = pins.get(b);
    return p === undefined || Math.abs(base[b] + (d - R) * dt - p) <= 0.25;
  };

  let score = new Float64Array(S);
  for (let d = 0; d < S; d++) score[d] = allowed(0, d) ? 0 : -Infinity;
  const back = [];
  for (let b = 0; b < B; b++) {
    const barDur = base[b + 1] - base[b];
    const K = Math.max(1, Math.ceil((maxStepFrac * barDur) / dt));
    const next = new Float64Array(S).fill(-Infinity);
    const bp = new Int32Array(S);
    const ns = byBar[b];
    for (let d2 = 0; d2 < S; d2++) {
      if (!allowed(b + 1, d2)) continue;
      const t1 = base[b + 1] + (d2 - R) * dt;
      let bestV = -Infinity, bestD = 0;
      for (let d1 = Math.max(0, d2 - K); d1 <= Math.min(S - 1, d2 + K); d1++) {
        const prev = score[d1];
        if (prev === -Infinity) continue;
        const tb = base[b] + (d1 - R) * dt;
        if (t1 - tb < 0.05) continue;
        let e = 0;
        for (const n of ns) e += ev(tb + n.frac * (t1 - tb), n.w);
        const rel = ((d2 - d1) * dt) / scoreLen[b];
        const v = prev + e - lambda * rel * rel;
        if (v > bestV) { bestV = v; bestD = d1; }
      }
      next[d2] = bestV;
      bp[d2] = bestD;
    }
    back.push(bp);
    score = next;
  }
  let d = 0;
  for (let i = 1; i < S; i++) if (score[i] > score[d]) d = i;
  if (score[d] === -Infinity) throw new Error('No timing fits these pinned measures. Clear the pins and try again.');
  const best = score[d];
  const path = new Array(B + 1);
  path[B] = d;
  for (let b = B - 1; b >= 0; b--) { d = back[b][d]; path[b] = d; }
  return { times: path.map((dd, b) => base[b] + (dd - R) * dt), score: best };
}

// Per measure (0-1, null without notes): both that its notes land on onsets
// and that the chosen position clearly beats shifted ones. Repetitive
// measures (e.g. only straight hi-hats) honestly come out uncertain.
function confidence(feat, dt, t0, byBar, times) {
  const ev = sampler(feat, dt, t0);
  const evidence = (ns, a, b) => ns.reduce((s, n) => s + ev(a + n.frac * (b - a), n.w), 0);
  return byBar.map((ns, b) => {
    if (!ns.length) return null;
    const a = times[b], z = times[b + 1];
    let hit = 0, total = 0;
    for (const n of ns) {
      const wsum = n.w[0] + n.w[1] + n.w[2];
      total += wsum;
      if (ev(a + n.frac * (z - a), n.w) >= 0.75 * wsum) hit += wsum;
    }
    const hitScore = Math.max(0, Math.min(1, (hit / total - 0.35) / 0.35));
    const chosen = evidence(ns, a, z);
    let rival = -Infinity;
    for (let s = -0.3; s <= 0.3 + 1e-9; s += dt) {
      if (Math.abs(s) >= 0.05) rival = Math.max(rival, evidence(ns, a + s, z + s));
    }
    const ratio = chosen <= 0 ? 0 : rival > 0 ? chosen / rival : 3;
    const peakScore = Math.max(0, Math.min(1, (ratio - 1) / 0.3));
    return Math.min(hitScore, peakScore);
  });
}

function fitLine(x, y) {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { slope, offset: (sy - slope * sx) / n };
}

// Base timing for one global candidate: its line, or straight through pins
// (with the candidate's tempo scale outside them).
function baseTimes(scoreTimes, cand, pinned) {
  return scoreTimes.map((t, b) => {
    if (!pinned.length) return cand.offset + cand.scale * t;
    if (pinned.length === 1) return pinned[0][1] + cand.scale * (t - scoreTimes[pinned[0][0]]);
    let i = pinned.findIndex(([pb]) => pb >= b);
    if (i <= 0) i = i === 0 ? 1 : pinned.length - 1;
    const [b0, p0] = pinned[i - 1], [b1, p1] = pinned[i];
    return p0 + ((p1 - p0) / (scoreTimes[b1] - scoreTimes[b0])) * (t - scoreTimes[b0]);
  });
}

// features: from onsetFeatures. notes: [{ bar, frac, w: [low, mid, high] }]
// (frac = score position inside the measure, 0-1). scoreTimes: score time of
// every measure start and the end. pins: [{ bar, time }] (soft constraints,
// in measure order). Returns { barTimes, confidence: [0-1 | null per
// measure], overall, method, scale, offset }.
export function alignBars(features, notes, scoreTimes, { pins = [], onProgress } = {}) {
  const B = scoreTimes.length - 1;
  if (B < 1) throw new Error('The chart has no measures.');
  if (!notes.length) throw new Error('The chart has no notes to align.');
  const progress = (from, to) => (p) => onProgress?.(from + (to - from) * p);

  const scoreLen = [];
  for (let b = 0; b < B; b++) scoreLen.push(scoreTimes[b + 1] - scoreTimes[b]);
  const noteTimes = notes.map((n) => scoreTimes[n.bar] + n.frac * scoreLen[n.bar]);
  const order = noteTimes.map((_, i) => i).sort((a, b) => noteTimes[a] - noteTimes[b]);
  const sortedTimes = order.map((i) => noteTimes[i]);
  const sortedW = new Float32Array(notes.length * 3);
  order.forEach((i, k) => notes[i].w.forEach((w, b) => { sortedW[k * 3 + b] = w; }));
  const byBar = notesByBar(notes, B);

  const fineDt = features.frame, fineT0 = features.t0;
  const coarseDt = fineDt * 2, coarseT0 = fineT0 + fineDt / 2;
  const coarse = pool(features.bands, 2, 1);
  const fine = features.bands.map((x) => gaussianSmooth(x, 1));

  const pinMap = new Map(pins.filter((p) => p.bar >= 0 && p.bar <= B).map((p) => [p.bar, p.time]));
  const pinned = [...pinMap].sort((a, b) => a[0] - b[0]);

  // a) global candidates; b) track each within ±4 s at coarse resolution
  // and keep the best-scoring path.
  const candidates = globalSearch(coarse, coarseDt, coarseT0, sortedTimes, sortedW, progress(0, 0.4));
  if (pinned.length >= 2) candidates.length = 1; // the pins define the line
  const lambda = 400;
  const R1 = Math.round(4 / coarseDt);
  let best = null, lastError = null;
  candidates.forEach((cand, i) => {
    try {
      const base = baseTimes(scoreTimes, cand, pinned);
      const tr = track(coarse, coarseDt, coarseT0, byBar, base, R1, 0.08, lambda, pinMap, scoreLen);
      if (!best || tr.score > best.tr.score) best = { cand, tr };
    } catch (err) {
      lastError = err;
    }
    onProgress?.(0.4 + 0.45 * (i + 1) / candidates.length);
  });
  if (!best) throw lastError || new Error('Could not align this recording.');

  // c) refine within ±60 ms at full resolution.
  const R2 = Math.round(0.06 / fineDt);
  const refined = track(fine, fineDt, fineT0, byBar, best.tr.times, R2, 1, lambda, pinMap, scoreLen).times;
  onProgress?.(0.95);

  // d) a straight line, if it fits about as well.
  const line = fitLine(scoreTimes, refined);
  const lineTimes = scoreTimes.map((t) => line.offset + line.slope * t);
  let maxDev = 0, ss = 0;
  for (let b = 0; b <= B; b++) { const r = refined[b] - lineTimes[b]; ss += r * r; maxDev = Math.max(maxDev, Math.abs(r)); }
  const rms = Math.sqrt(ss / (B + 1));
  const constant = rms < 0.006 && maxDev < 0.02 && !pinned.length;
  const barTimes = constant ? lineTimes : refined;

  const conf = confidence(fine, fineDt, fineT0, byBar, barTimes);
  const known = conf.filter((c) => c !== null).sort((a, b) => a - b);
  const overall = known.length ? known[Math.floor(known.length / 2)] : 0;
  onProgress?.(1);
  return {
    barTimes,
    confidence: conf,
    overall,
    method: constant ? 'constant' : 'tracked',
    scale: best.cand.scale,
    offset: best.cand.offset,
  };
}

