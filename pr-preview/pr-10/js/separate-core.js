// Chunked source separation: a streaming port of MSST's `demix`
// (ZFTurbo/Music-Source-Separation-Training, utils/model_utils.py).
//
// The model itself is a callback that maps one chunk of stereo audio to the
// separated stems of that chunk (the ONNX graphs made by
// tools/msst-onnx/export.py contain their own STFT, so no spectral code
// lives here). This module does what MSST does around the model:
//
//  - 'generic' mode (MDX23C, SCNet, Roformers…): reflect-pad the song by
//    `border = chunk - step`, run overlapping chunks with a linear fade
//    window (fade = chunk / 10; flat at the song's very start and end),
//    and normalize by the summed window.
//  - 'demucs' mode (HTDemucs): plain average of overlapping chunks, zero
//    padding, no border.
//
// Output is streamed: once a chunk is done, every sample before the next
// chunk's start is final and is handed to `onOutput`, so memory stays at a
// couple of chunks per stem instead of whole-song arrays.

// mix: [left, right] Float32Arrays (equal length) at the model's rate.
// manifest: { chunk, overlap, stems: [...], mode: 'generic'|'demucs', normalize }
// runChunk(input: Float32Array(2 * chunk) planar L|R)
//   -> Promise<Float32Array(stems * 2 * chunk)>, layout [stem][channel][t]
// onOutput(pos, blocks): blocks[stem][channel] = Float32Array, the final
//   samples [pos, pos + len) of each stem. Called in order, without gaps.
export async function demix(mix, manifest, runChunk, { onOutput, onProgress, signal } = {}) {
  const C = manifest.chunk;
  const S = manifest.stems.length;
  const overlap = Math.max(1, manifest.overlap | 0);
  const step = Math.floor(C / overlap);
  const generic = manifest.mode !== 'demucs';
  const L = mix[0].length;
  if (!L) return;

  // Optional input normalization (config.inference.normalize).
  let mean = 0;
  let std = 1;
  if (manifest.normalize) {
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < L; i++) {
      const m = (mix[0][i] + mix[1][i]) / 2;
      s += m;
      s2 += m * m;
    }
    mean = s / L;
    std = Math.sqrt(Math.max(1e-16, s2 / L - mean * mean)) || 1;
  }

  const border = C - step;
  // Without overlap there is nothing to cross-fade with; MSST's fades would
  // zero the samples at every chunk edge, so use a flat window instead.
  const fade = generic && border > 0 ? Math.floor(C / 10) : 0;
  const padded = generic && border > 0 && L > 2 * border;
  const off = padded ? border : 0; // padded coordinate of the song's sample 0
  const total = L + 2 * off; // padded length

  // Sample of the (virtually) reflect-padded, normalized song.
  const at = (c, j) => {
    let k = j - off;
    if (k < 0) k = -k;
    else if (k >= L) k = 2 * (L - 1) - k;
    return (mix[c][k] - mean) / std;
  };

  const window = new Float32Array(C).fill(1);
  for (let i = 0; i < fade; i++) {
    window[i] = fade > 1 ? i / (fade - 1) : 0;
    window[C - fade + i] = fade > 1 ? 1 - i / (fade - 1) : 0;
  }

  // Accumulators for padded positions [base, base + C).
  const acc = new Float32Array(S * 2 * C);
  const cnt = new Float32Array(C);
  const input = new Float32Array(2 * C);
  const nChunks = Math.ceil(total / step);
  let emitted = 0; // padded position up to which output was emitted

  const emit = (upTo) => {
    // Padded range [emitted, upTo) is final; it sits at acc[0 .. n).
    const n = upTo - emitted;
    const songFrom = Math.max(emitted, off);
    const songTo = Math.min(upTo, off + L);
    if (songTo > songFrom) {
      const a = songFrom - emitted;
      const len = songTo - songFrom;
      const blocks = [];
      for (let s = 0; s < S; s++) {
        const chans = [];
        for (let c = 0; c < 2; c++) {
          const out = new Float32Array(len);
          const base = (s * 2 + c) * C + a;
          for (let i = 0; i < len; i++) {
            const w = cnt[a + i];
            out[i] = w > 0 ? (acc[base + i] / w) * std + mean : 0;
          }
          chans.push(out);
        }
        blocks.push(chans);
      }
      onOutput?.(songFrom - off, blocks);
    }
    // Shift the accumulators left by n.
    for (let r = 0; r < S * 2; r++) acc.copyWithin(r * C, r * C + n, (r + 1) * C).fill(0, (r + 1) * C - n, (r + 1) * C);
    cnt.copyWithin(0, n).fill(0, C - n);
    emitted = upTo;
  };

  for (let k = 0, start = 0; start < total; k++, start += step) {
    if (signal?.aborted) throw new DOMException('Separation cancelled', 'AbortError');
    const len = Math.min(C, total - start);
    const reflect = generic && len > C / 2;
    for (let c = 0; c < 2; c++) {
      const dst = c * C;
      for (let i = 0; i < len; i++) input[dst + i] = at(c, start + i);
      for (let i = len; i < C; i++) {
        // Reflect within the chunk (MSST pads the part itself), else zeros.
        input[dst + i] = reflect ? input[dst + 2 * (len - 1) - i] : 0;
      }
    }

    const out = await runChunk(input);

    const w = generic ? window.slice() : null;
    if (generic) {
      if (start === 0) w.fill(1, 0, fade);
      if (start + step >= total) w.fill(1, C - fade);
    }
    const rel = start - emitted; // always 0: chunks start where emission stopped
    for (let s = 0; s < S; s++) {
      for (let c = 0; c < 2; c++) {
        const src = (s * 2 + c) * C;
        const dst = (s * 2 + c) * C + rel;
        for (let i = 0; i < len; i++) acc[dst + i] += out[src + i] * (w ? w[i] : 1);
      }
    }
    for (let i = 0; i < len; i++) cnt[rel + i] += w ? w[i] : 1;

    emit(Math.min(start + step, total));
    onProgress?.((k + 1) / nChunks);
  }
}
