// Streaming 16-bit FLAC encoder (no dependencies), used to store separated
// stems compactly. Drum stems are mostly near-silence, which FLAC packs into
// a fraction of a WAV's size; every browser's decodeAudioData reads FLAC.
//
// Features: fixed blocking (4096), CONSTANT / VERBATIM / FIXED (order 0-4)
// subframes, partitioned Rice residuals, stereo decorrelation (left/side,
// right/side, mid/side). MD5 is left zero ("unknown"), which the format allows.
//
//   const enc = new FlacEncoder(44100, 2);
//   enc.push([left, right]);   // Float32Arrays in [-1, 1], any length
//   const blob = enc.finish();

const BLOCK = 4096;
const MAX_PARTITION_ORDER = 8;

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 0x80 ? (c << 1) ^ 0x07 : c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let j = 0; j < 8; j++) d = (d & 0x8000 ? (d << 1) ^ 0x8005 : d << 1) & 0xffff;
  CRC16[i] = d;
}

class BitWriter {
  constructor(size = 1 << 16) {
    this.buf = new Uint8Array(size);
    this.pos = 0; // bytes written
    this.acc = 0; // pending bits (MSB first), fewer than 8 + n
    this.nacc = 0;
  }

  _ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.pos));
    this.buf = b;
  }

  // Unsigned value of n bits (n <= 24 per call keeps acc within 32 bits).
  bits(value, n) {
    if (n > 24) {
      this.bits(Math.floor(value / 0x1000000) & ((1 << (n - 24)) - 1), n - 24);
      this.bits(value & 0xffffff, 24);
      return;
    }
    this._ensure(4);
    this.acc = (this.acc << n) | (value & ((1 << n) - 1));
    this.nacc += n;
    while (this.nacc >= 8) {
      this.nacc -= 8;
      this.buf[this.pos++] = (this.acc >>> this.nacc) & 0xff;
    }
    this.acc &= (1 << this.nacc) - 1;
  }

  signed(value, n) {
    this.bits(value < 0 ? value + 2 ** n : value, n);
  }

  // q zeros followed by a one.
  unary(q) {
    while (q >= 24) { this.bits(0, 24); q -= 24; }
    this.bits(1, q + 1);
  }

  align() {
    if (this.nacc) this.bits(0, 8 - this.nacc);
  }

  bytes() {
    return this.buf.subarray(0, this.pos);
  }
}

// Residual of the fixed predictor of the given order, for samples order..n-1.
function fixedResidual(x, n, order, out) {
  switch (order) {
    case 0: for (let i = 0; i < n; i++) out[i] = x[i]; break;
    case 1: for (let i = 1; i < n; i++) out[i] = x[i] - x[i - 1]; break;
    case 2: for (let i = 2; i < n; i++) out[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
    case 3: for (let i = 3; i < n; i++) out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
    case 4: for (let i = 4; i < n; i++) out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]; break;
  }
}

const zig = (r) => (r >= 0 ? 2 * r : -2 * r - 1);

function riceParam(sum, count) {
  if (count <= 0 || sum <= count) return 0;
  return Math.min(14, Math.max(0, Math.floor(Math.log2(sum / count))));
}

// Chooses the partition order and per-partition Rice parameters for the
// residual res[order..n-1]. Returns { bits, porder, params }.
function planResidual(res, n, order) {
  let maxP = 0;
  while (maxP < MAX_PARTITION_ORDER && n % (2 << maxP) === 0 && (n >> (maxP + 1)) > order) maxP++;
  // Zigzag sums for the finest partitions; coarser ones are merged sums.
  const parts = 1 << maxP;
  const plen = n >> maxP;
  const sums = new Float64Array(parts);
  for (let p = 0; p < parts; p++) {
    let s = 0;
    for (let i = p === 0 ? order : p * plen, end = (p + 1) * plen; i < end; i++) s += zig(res[i]);
    sums[p] = s;
  }
  let best = null;
  let level = sums;
  for (let po = maxP; po >= 0; po--) {
    const count = level.length;
    const len = n >> po;
    let bits = 0;
    const params = new Array(count);
    for (let p = 0; p < count; p++) {
      const cnt = p === 0 ? len - order : len;
      const k = riceParam(level[p], cnt);
      params[p] = k;
      bits += 4 + cnt * (k + 1) + Math.floor(level[p] / 2 ** k);
    }
    if (!best || bits < best.bits) best = { bits, porder: po, params };
    if (po > 0) {
      const next = new Float64Array(count >> 1);
      for (let p = 0; p < next.length; p++) next[p] = level[2 * p] + level[2 * p + 1];
      level = next;
    }
  }
  return best;
}

// Picks the cheapest encoding of one channel's block. bps: bits per sample.
function planSubframe(x, n, bps, scratch) {
  let constant = true;
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) return { type: 'const', bits: bps };

  let best = { type: 'verbatim', bits: n * bps };
  for (let order = 0; order <= Math.min(4, n - 1); order++) {
    const res = scratch[order];
    fixedResidual(x, n, order, res);
    const plan = planResidual(res, n, order);
    const bits = order * bps + 6 + plan.bits;
    if (bits < best.bits) best = { type: 'fixed', order, bits, plan, res };
  }
  return best;
}

function writeSubframe(w, x, n, bps, sf) {
  if (sf.type === 'const') {
    w.bits(0, 8); // pad 0, type 000000, no wasted bits
    w.signed(x[0], bps);
    return;
  }
  if (sf.type === 'verbatim') {
    w.bits(0b00000010, 8);
    for (let i = 0; i < n; i++) w.signed(x[i], bps);
    return;
  }
  const { order, plan, res } = sf;
  w.bits((0b001000 | order) << 1, 8);
  for (let i = 0; i < order; i++) w.signed(x[i], bps);
  w.bits(0, 2); // Rice, 4-bit parameters
  w.bits(plan.porder, 4);
  const len = n >> plan.porder;
  for (let p = 0; p < plan.params.length; p++) {
    const k = plan.params[p];
    w.bits(k, 4);
    const mask = (1 << k) - 1;
    for (let i = p === 0 ? order : p * len, end = (p + 1) * len; i < end; i++) {
      const u = zig(res[i]);
      w.unary(Math.floor(u / 2 ** k));
      if (k) w.bits(u & mask, k);
    }
  }
}

function utf8Number(w, v) {
  if (v < 0x80) { w.bits(v, 8); return; }
  const bytes = [];
  let first = 0xc0;
  let room = 0x1f;
  while (v > room) {
    bytes.unshift(0x80 | (v & 0x3f));
    v = Math.floor(v / 64);
    first = 0x80 | (first >> 1);
    room >>= 1;
  }
  w.bits(first | v, 8);
  for (const b of bytes) w.bits(b, 8);
}

export class FlacEncoder {
  constructor(sampleRate, channels) {
    if (channels < 1 || channels > 2) throw new Error('FlacEncoder supports 1 or 2 channels');
    this.rate = sampleRate;
    this.channels = channels;
    this.pending = Array.from({ length: channels }, () => new Int32Array(BLOCK));
    this.fill = 0;
    this.frames = [];
    this.frameNo = 0;
    this.total = 0;
    this.minFrame = Infinity;
    this.maxFrame = 0;
    this.scratch = Array.from({ length: 5 }, () => new Int32Array(BLOCK));
    this.side = new Int32Array(BLOCK);
    this.mid = new Int32Array(BLOCK);
  }

  // chans: one Float32Array per channel, equal lengths.
  push(chans) {
    const len = chans[0].length;
    let i = 0;
    while (i < len) {
      const take = Math.min(BLOCK - this.fill, len - i);
      for (let c = 0; c < this.channels; c++) {
        const src = chans[c];
        const dst = this.pending[c];
        for (let j = 0; j < take; j++) {
          const v = Math.round(src[i + j] * 32768);
          dst[this.fill + j] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        }
      }
      this.fill += take;
      i += take;
      if (this.fill === BLOCK) this._frame();
    }
  }

  _frame() {
    const n = this.fill;
    if (!n) return;
    const w = new BitWriter(n * this.channels * 3 + 64);

    // Channel assignment and the subframes to write.
    let assign = this.channels - 1;
    let subs;
    if (this.channels === 1) {
      subs = [[this.pending[0], 16]];
    } else {
      const [L, R] = this.pending;
      const S = this.side;
      const M = this.mid;
      for (let i = 0; i < n; i++) { S[i] = L[i] - R[i]; M[i] = (L[i] + R[i]) >> 1; }
      const plan = (x, bps) => planSubframe(x, n, bps, this.scratch).bits;
      const bl = plan(L, 16);
      const br = plan(R, 16);
      const bs = plan(S, 17);
      const bm = plan(M, 16);
      const opts = [[bl + br, 1], [bl + bs, 8], [br + bs, 9], [bm + bs, 10]];
      opts.sort((a, b) => a[0] - b[0]);
      assign = opts[0][1];
      subs = assign === 1 ? [[L, 16], [R, 16]]
        : assign === 8 ? [[L, 16], [S, 17]]
          : assign === 9 ? [[S, 17], [R, 16]]
            : [[M, 16], [S, 17]];
    }

    // Header.
    w.bits(0xfff8, 16); // sync, reserved 0, fixed blocking
    w.bits(0b0111, 4); // block size: 16-bit value at end of header
    w.bits(0b0000, 4); // sample rate from STREAMINFO
    w.bits(assign, 4);
    w.bits(0b100, 3); // 16 bits per sample
    w.bits(0, 1);
    utf8Number(w, this.frameNo++);
    w.bits(n - 1, 16);
    let crc = 0;
    for (const b of w.bytes()) crc = CRC8[crc ^ b];
    w.bits(crc, 8);

    for (const [x, bps] of subs) {
      // Plans are recomputed per subframe so `res` scratch buffers are current.
      writeSubframe(w, x, n, bps, planSubframe(x, n, bps, this.scratch));
    }
    w.align();
    let crc16 = 0;
    for (const b of w.bytes()) crc16 = ((crc16 << 8) ^ CRC16[(crc16 >> 8) ^ b]) & 0xffff;
    w.bits(crc16, 16);

    const bytes = w.bytes().slice();
    this.frames.push(bytes);
    this.minFrame = Math.min(this.minFrame, bytes.length);
    this.maxFrame = Math.max(this.maxFrame, bytes.length);
    this.total += n;
    this.fill = 0;
  }

  finish() {
    this._frame();
    const w = new BitWriter(64);
    w.bits(0x664c6143, 32); // "fLaC"
    w.bits(0x80, 8); // last metadata block, STREAMINFO
    w.bits(34, 24);
    w.bits(BLOCK, 16);
    w.bits(BLOCK, 16);
    w.bits(this.frames.length ? this.minFrame : 0, 24);
    w.bits(this.maxFrame, 24);
    w.bits(this.rate, 20);
    w.bits(this.channels - 1, 3);
    w.bits(15, 5);
    w.bits(Math.floor(this.total / 2 ** 32), 4);
    w.bits(this.total % 2 ** 32, 32);
    for (let i = 0; i < 16; i++) w.bits(0, 8); // MD5 unknown
    const head = w.bytes().slice();
    const blob = new Blob([head, ...this.frames], { type: 'audio/flac' });
    this.frames = [];
    return blob;
  }
}
