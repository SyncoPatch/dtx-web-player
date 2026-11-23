// Ogg Opus (RFC 7845) on top of WebCodecs, used to store separated stems
// compactly. Browsers can encode Opus (AudioEncoder) but not write the Ogg
// container, and not every browser's decodeAudioData reads Ogg Opus, so this
// module has both directions:
//
//   OpusOggEncoder — push() Float32 channels, finish() -> Blob (audio/ogg)
//   decodeOggOpus  — Ogg Opus bytes -> AudioBuffer via AudioDecoder, the
//                    fallback when decodeAudioData rejects the file
//
// Timing is sample-accurate: the OpusHead pre-skip and the final granule
// position trim the codec delay and the padding of the last frame, which
// matters because per-hit keysounds are cut from these stems.

const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 24;
  for (let j = 0; j < 8; j++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  CRC[i] = c >>> 0;
}

function crc32(bytes) {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return c;
}

// Samples (at 48 kHz) in one Opus packet, from its TOC byte (RFC 6716 §3.1).
export function opusPacketSamples(pkt) {
  if (!pkt.length) return 0;
  const config = pkt[0] >> 3;
  let frame;
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3];
  else if (config < 16) frame = [480, 960][config & 1];
  else frame = [120, 240, 480, 960][config & 3];
  const code = pkt[0] & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : (pkt[1] ?? 0) & 0x3f;
  return frame * frames;
}

function opusHead(channels, inputRate, preSkip = 312) {
  const b = new Uint8Array(19);
  const v = new DataView(b.buffer);
  b.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
  b[8] = 1;
  b[9] = channels;
  v.setUint16(10, preSkip, true);
  v.setUint32(12, inputRate, true);
  return b;
}

function opusTags() {
  const vendor = new TextEncoder().encode('DTX Web Player');
  const b = new Uint8Array(8 + 4 + vendor.length + 4);
  const v = new DataView(b.buffer);
  b.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // "OpusTags"
  v.setUint32(8, vendor.length, true);
  b.set(vendor, 12);
  return b; // zero user comments
}

class OggWriter {
  constructor() {
    this.serial = (Math.random() * 0x100000000) >>> 0;
    this.seq = 0;
    this.pages = [];
  }

  // packets: Uint8Array[] that all end on this page.
  page(packets, granule, flags) {
    const segs = [];
    for (const p of packets) {
      let n = p.length;
      while (n >= 255) { segs.push(255); n -= 255; }
      segs.push(n);
    }
    const body = packets.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(27 + segs.length + body);
    const v = new DataView(out.buffer);
    out.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
    out[5] = flags;
    v.setUint32(6, granule % 0x100000000, true);
    v.setUint32(10, Math.floor(granule / 0x100000000), true);
    v.setUint32(14, this.serial, true);
    v.setUint32(18, this.seq++, true);
    out[26] = segs.length;
    out.set(segs, 27);
    let o = 27 + segs.length;
    for (const p of packets) { out.set(p, o); o += p.length; }
    v.setUint32(22, crc32(out), true);
    this.pages.push(out);
  }
}

// Streaming windowed-sinc resampler with zero delay (symmetric kernel), so
// timing survives the conversion exactly. Letting the encoder resample was
// measurably late (Chrome: 32 samples at 44.1 kHz).
const HALF = 24; // taps each side, at the input rate

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

function besselI0(x) {
  let s = 1;
  let t = 1;
  for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; }
  return s;
}

export class Resampler {
  constructor(from, to, channels) {
    const g = gcd(from, to);
    this.up = to / g; // phases
    this.down = from / g;
    this.channels = channels;
    const cutoff = 0.97 * Math.min(1, to / from); // of the input Nyquist
    const beta = 9;
    this.table = new Float32Array(this.up * 2 * HALF);
    for (let p = 0; p < this.up; p++) {
      const frac = p / this.up;
      for (let k = 0; k < 2 * HALF; k++) {
        const x = k - HALF + 1 - frac; // tap distance in input samples
        const s = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
        const r = x / HALF;
        const w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / besselI0(beta);
        this.table[p * 2 * HALF + k] = cutoff * s * w;
      }
    }
    // Input history; starts with HALF zeros so output 0 sits on input 0.
    this.buf = Array.from({ length: channels }, () => new Float32Array(1 << 16));
    this.len = HALF - 1;
    this.base = -(HALF - 1); // input index of buf[0]
    this.j = 0; // next output index
  }

  _append(chans) {
    const n = chans[0].length;
    if (this.len + n > this.buf[0].length) {
      let size = this.buf[0].length;
      while (size < this.len + n) size *= 2;
      this.buf = this.buf.map((b) => { const nb = new Float32Array(size); nb.set(b.subarray(0, this.len)); return nb; });
    }
    for (let c = 0; c < this.channels; c++) this.buf[c].set(chans[c], this.len);
    this.len += n;
  }

  // Resamples what the history allows; final = pad the end with zeros.
  _run(final) {
    const out = Array.from({ length: this.channels }, () => []);
    const avail = this.base + this.len; // input samples available
    for (;;) {
      const num = this.j * this.down;
      const i = Math.floor(num / this.up); // input sample at or before the output time
      if (i + HALF >= avail && !final) break;
      if (final && i >= this.end) break;
      const p = num - i * this.up;
      const t = p * 2 * HALF;
      const start = i - HALF + 1 - this.base;
      for (let c = 0; c < this.channels; c++) {
        const b = this.buf[c];
        let s = 0;
        for (let k = 0; k < 2 * HALF; k++) {
          const at = start + k;
          if (at < this.len) s += b[at] * this.table[t + k];
        }
        out[c].push(s);
      }
      this.j++;
    }
    // Drop history no longer needed.
    const keep = Math.floor((this.j * this.down) / this.up) - HALF + 1 - this.base;
    if (keep > 0) {
      for (let c = 0; c < this.channels; c++) this.buf[c].copyWithin(0, keep, this.len);
      this.len -= keep;
      this.base += keep;
    }
    return out.map((a) => Float32Array.from(a));
  }

  push(chans) {
    this._append(chans);
    return this._run(false);
  }

  // Remaining output; total output = ceil(inputLength * to / from).
  flush() {
    this.end = this.base + this.len; // input length (base counts the zero padding)
    return this._run(true);
  }
}

export class OpusOggEncoder {
  static async supported(channels, bitrate) {
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return false;
    try {
      const r = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: channels, bitrate });
      return !!r.supported;
    } catch {
      return false;
    }
  }

  // sampleRate: of the pushed audio; it is converted to Opus' 48 kHz here.
  constructor(sampleRate, channels, bitrate) {
    this.inputRate = sampleRate;
    this.resampler = sampleRate === 48000 ? null : new Resampler(sampleRate, 48000, channels);
    this.rate = 48000;
    this.channels = channels;
    this.inputFrames = 0;
    this.frames = 0; // 48 kHz frames sent to the encoder
    this.packets = [];
    this.head = null;
    this.error = null;
    this.encoder = new AudioEncoder({
      output: (chunk, meta) => {
        const desc = meta?.decoderConfig?.description;
        if (!this.head && desc) {
          this.head = new Uint8Array(ArrayBuffer.isView(desc) ? desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength) : desc.slice(0));
        }
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        this.packets.push(b);
      },
      error: (e) => { this.error = e; },
    });
    this.encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: channels, bitrate });
  }

  // chans: one Float32Array per channel, equal lengths, at the input rate.
  push(chans) {
    if (this.error) throw this.error;
    this.inputFrames += chans[0].length;
    this._encode(this.resampler ? this.resampler.push(chans) : chans);
  }

  _encode(chans) {
    const n = chans[0].length;
    if (!n) return;
    const data = new Float32Array(n * this.channels);
    chans.forEach((c, i) => data.set(c, i * n));
    const audio = new AudioData({
      format: 'f32-planar',
      sampleRate: this.rate,
      numberOfFrames: n,
      numberOfChannels: this.channels,
      timestamp: Math.round((this.frames * 1e6) / this.rate),
      data,
    });
    this.encoder.encode(audio);
    audio.close();
    this.frames += n;
  }

  async finish() {
    if (this.resampler) this._encode(this.resampler.flush());
    await this.encoder.flush();
    this.encoder.close();
    if (this.error) throw this.error;
    const isHead = this.head && this.head.length >= 19 && String.fromCharCode(...this.head.subarray(0, 8)) === 'OpusHead';
    const head = isHead ? this.head : opusHead(this.channels, this.inputRate);
    new DataView(head.buffer, head.byteOffset).setUint32(12, this.inputRate, true); // informational
    const preSkip = head[10] | (head[11] << 8);

    const w = new OggWriter();
    w.page([head], 0, 0x02);
    w.page([opusTags()], 0, 0);
    // The last granule position marks the true end (pre-skip + input length
    // at 48 kHz), so decoders drop the padding of the final frame.
    const end = preSkip + this.frames;
    let granule = 0;
    let page = [];
    let bytes = 0;
    for (let i = 0; i < this.packets.length; i++) {
      const p = this.packets[i];
      granule += opusPacketSamples(p);
      page.push(p);
      bytes += p.length;
      const last = i === this.packets.length - 1;
      if (last || page.length >= 50 || bytes > 8000) {
        w.page(page, last ? Math.min(granule, end) : granule, last ? 0x04 : 0);
        page = [];
        bytes = 0;
      }
    }
    if (!this.packets.length) w.page([], 0, 0x04);
    this.packets = [];
    return new Blob(w.pages, { type: 'audio/ogg' });
  }
}

// ---------------------------------------------------------------------------

// { head, packets, granule } from Ogg bytes (first logical stream only).
export function demuxOgg(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const packets = [];
  let cur = [];
  let granule = 0;
  let serial = null;
  for (let o = 0; o + 27 <= u8.length;) {
    if (v.getUint32(o) !== 0x4f676753) throw new Error('Corrupt Ogg data');
    const nseg = u8[o + 26];
    const s = v.getUint32(o + 14, true);
    const gHi = v.getUint32(o + 10, true);
    const g = gHi === 0xffffffff ? -1 : v.getUint32(o + 6, true) + gHi * 0x100000000; // -1: no packet ends here
    let p = o + 27 + nseg;
    const mine = serial === null || s === serial;
    if (serial === null) serial = s;
    for (let i = 0; i < nseg; i++) {
      const len = u8[o + 27 + i];
      if (mine) cur.push(u8.subarray(p, p + len));
      p += len;
      if (mine && len < 255) {
        const total = cur.reduce((a, c) => a + c.length, 0);
        const pkt = new Uint8Array(total);
        let k = 0;
        for (const c of cur) { pkt.set(c, k); k += c.length; }
        packets.push(pkt);
        cur = [];
      }
    }
    if (mine && g > 0) granule = g;
    o = p;
  }
  const head = packets.shift();
  if (packets.length && String.fromCharCode(...packets[0].subarray(0, 8)) === 'OpusTags') packets.shift();
  return { head, packets, granule };
}

export function isOggOpus(buf) {
  const u8 = new Uint8Array(buf, 0, Math.min(buf.byteLength, 64));
  if (u8.length < 36 || u8[0] !== 0x4f || u8[1] !== 0x67 || u8[2] !== 0x67 || u8[3] !== 0x53) return false;
  const at = 27 + u8[26];
  return String.fromCharCode(...u8.subarray(at, at + 8)) === 'OpusHead';
}

// Decodes Ogg Opus with WebCodecs into an AudioBuffer at 48 kHz.
export async function decodeOggOpus(ctx, buf) {
  if (typeof AudioDecoder === 'undefined') throw new Error('This browser cannot decode Opus audio.');
  const { head, packets, granule } = demuxOgg(buf);
  const channels = head[9];
  const preSkip = head[10] | (head[11] << 8);
  const parts = [];
  let error = null;
  const dec = new AudioDecoder({
    output: (a) => {
      const n = a.numberOfFrames;
      const chans = [];
      for (let c = 0; c < channels; c++) {
        const d = new Float32Array(n);
        a.copyTo(d, { planeIndex: c, format: 'f32-planar' });
        chans.push(d);
      }
      parts.push(chans);
      a.close();
    },
    error: (e) => { error = e; },
  });
  dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: channels, description: head });
  let ts = 0;
  for (const p of packets) {
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((ts * 1e6) / 48000), data: p }));
    ts += opusPacketSamples(p);
  }
  await dec.flush();
  dec.close();
  if (error) throw error;

  const decoded = parts.reduce((a, p) => a + p[0].length, 0);
  // Decoders differ in whether they apply the pre-skip themselves.
  const skip = Math.abs(decoded - ts) < Math.abs(decoded - (ts - preSkip)) ? preSkip : 0;
  const length = Math.max(1, Math.min(decoded - skip, (granule || ts) - preSkip));
  const out = ctx.createBuffer(channels, length, 48000);
  for (let c = 0; c < channels; c++) {
    const dst = out.getChannelData(c);
    let pos = -skip;
    for (const p of parts) {
      const src = p[c];
      const from = Math.max(0, -pos);
      const to = Math.min(src.length, length - pos);
      if (to > from) dst.set(src.subarray(from, to), pos + from);
      pos += src.length;
    }
  }
  return out;
}
