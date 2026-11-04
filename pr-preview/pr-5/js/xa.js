// Decoder for BandJAM XA audio (".xa", magic "KWD1"), a 4/6/8-bit ADPCM
// format common in DTX packages. DTXMania decodes it with the closed-source
// xadec.dll; this is an independent implementation of the on-disk format as
// documented by the bjxa project (Dridi Boukelmoune, bjxa(5)).
//
// Layout: a 32-byte little-endian header, then blocks of 32 samples. A block
// is one profile byte (range in the low nibble, filter in the high nibble)
// followed by 32 samples packed MSB-first. Stereo interleaves an L block and
// an R block. Each sample is the top bits of an int16; it's shifted right by
// the range, then a two-tap predictor over the channel's previous two output
// samples is added. The predictor history starts at zero (xadec ignores the
// header's befL/befR) and carries across blocks.

const HEADER = 32;
const BLOCK_SAMPLES = 32;
// Predictor coefficients ×256 (K0 for the previous sample, K1 for the one before).
const K = [[0, 0], [240, 0], [460, -208], [392, -220], [488, -240]];

export function isXA(buf) {
  if (buf.byteLength < 4) return false;
  const b = new Uint8Array(buf, 0, 4);
  return b[0] === 0x4b && b[1] === 0x57 && b[2] === 0x44 && b[3] === 0x31; // "KWD1"
}

// Returns { sampleRate, channels: Float32Array[] } with samples in [-1, 1).
export function decodeXA(buf) {
  if (buf.byteLength < HEADER || !isXA(buf)) throw new Error('not a KWD1 XA file');
  const v = new DataView(buf);
  const dataLen = v.getUint32(4, true);
  const nSamples = v.getUint32(8, true);
  const sampleRate = v.getUint16(12, true);
  const bits = v.getUint8(14);
  const nch = v.getUint8(15);
  if (bits !== 4 && bits !== 6 && bits !== 8) throw new Error(`XA: unsupported ${bits}-bit samples`);
  if (nch !== 1 && nch !== 2) throw new Error(`XA: unsupported channel count ${nch}`);
  if (!sampleRate) throw new Error('XA: zero sample rate');

  const blockSize = 1 + (BLOCK_SAMPLES * bits) / 8;
  const groupSize = blockSize * nch;
  const groups = Math.ceil(nSamples / BLOCK_SAMPLES);
  if (groups * groupSize > dataLen || HEADER + groups * groupSize > buf.byteLength) {
    throw new Error('XA: truncated data');
  }

  const src = new Uint8Array(buf, HEADER);
  const out = [];
  for (let c = 0; c < nch; c++) out.push(new Float32Array(nSamples));
  const raw = new Int32Array(BLOCK_SAMPLES);
  const prev0 = new Int32Array(nch);
  const prev1 = new Int32Array(nch);

  let pos = 0;
  for (let g = 0; g < groups; g++) {
    const base = g * BLOCK_SAMPLES;
    const count = Math.min(BLOCK_SAMPLES, nSamples - base);
    for (let c = 0; c < nch; c++) {
      const profile = src[pos];
      const range = profile & 0x0f;
      const filter = profile >> 4;
      if (filter >= K.length) throw new Error(`XA: invalid filter ${filter}`);
      let p = pos + 1;
      // Unpack into sign-extended int16 values (top bits set, low bits zero).
      if (bits === 4) {
        for (let i = 0; i < BLOCK_SAMPLES; i += 2, p++) {
          const b = src[p];
          raw[i] = ((b & 0xf0) << 24) >> 16;
          raw[i + 1] = ((b & 0x0f) << 28) >> 16;
        }
      } else if (bits === 6) {
        for (let i = 0; i < BLOCK_SAMPLES; i += 4, p += 3) {
          const s = (src[p] << 16) | (src[p + 1] << 8) | src[p + 2];
          raw[i] = ((s >> 18) << 26) >> 16;
          raw[i + 1] = (((s >> 12) & 0x3f) << 26) >> 16;
          raw[i + 2] = (((s >> 6) & 0x3f) << 26) >> 16;
          raw[i + 3] = ((s & 0x3f) << 26) >> 16;
        }
      } else {
        for (let i = 0; i < BLOCK_SAMPLES; i++, p++) raw[i] = (src[p] << 24) >> 16;
      }
      pos += blockSize;

      const k0 = K[filter][0];
      const k1 = K[filter][1];
      let p0 = prev0[c];
      let p1 = prev1[c];
      const dst = out[c];
      for (let i = 0; i < BLOCK_SAMPLES; i++) {
        // Truncating division (not >> 8) matches the reference decoder.
        let s = (raw[i] >> range) + (((p0 * k0 + p1 * k1) / 256) | 0);
        if (s < -32768) s = -32768;
        else if (s > 32767) s = 32767;
        p1 = p0;
        p0 = s;
        if (i < count) dst[base + i] = s / 32768;
      }
      prev0[c] = p0;
      prev1[c] = p1;
    }
  }
  return { sampleRate, channels: out };
}
