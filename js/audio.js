// Decodes the WAV definitions referenced by a chart into AudioBuffers.
//
// Primary path is the browser's decodeAudioData. Safari (iPad/iPhone) cannot
// decode OGG Vorbis — which most DTX packages use — so a vendored WASM
// decoder (js/vendor/stbvorbis.js, Apache-2.0) is lazily loaded as a
// fallback when native decoding fails on an OGG file.

let vorbisReady = null;

function loadVorbis() {
  if (!vorbisReady) {
    vorbisReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      // Classic script exposing a global; it locates its asm.js sibling via
      // document.currentScript, so it must be loaded with a <script> tag.
      s.src = new URL('./vendor/stbvorbis.js', import.meta.url);
      s.onload = () => resolve(window.stbvorbis);
      s.onerror = () => reject(new Error('failed to load the Vorbis decoder'));
      document.head.append(s);
    });
  }
  return vorbisReady;
}

function isOgg(buf) {
  const b = new Uint8Array(buf, 0, 4);
  return b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53; // "OggS"
}

async function decodeVorbis(ctx, arrayBuffer) {
  const stb = await loadVorbis();
  const chunks = []; // arrays of per-channel Float32Arrays, streamed
  let sampleRate = 0;
  await new Promise((resolve, reject) => {
    stb.decode(new Uint8Array(arrayBuffer), (result) => {
      if (result.error) { reject(new Error(result.error)); return; }
      if (result.eof) { resolve(); return; }
      if (result.data && result.data.length) {
        chunks.push(result.data);
        sampleRate = result.sampleRate;
      }
    });
  });
  if (!chunks.length || !sampleRate) throw new Error('empty Vorbis stream');

  const nch = chunks[0].length;
  const total = chunks.reduce((a, c) => a + c[0].length, 0);
  const buffer = ctx.createBuffer(nch, total, sampleRate);
  for (let ch = 0; ch < nch; ch++) {
    const out = buffer.getChannelData(ch);
    let off = 0;
    for (const c of chunks) {
      out.set(c[ch], off);
      off += c[ch].length;
    }
  }
  return buffer;
}

export class SoundBank {
  constructor(audioCtx) {
    this.ctx = audioCtx;
    this.sounds = new Map(); // wavId -> { buffer, volume, pan }
  }

  get(wavId) {
    return this.sounds.get(wavId) || null;
  }

  clear() {
    this.sounds.clear();
  }

  // Decode one file with the native decoder, falling back to the vendored
  // Vorbis decoder for OGG data the browser rejects (Safari).
  async decode(blob) {
    try {
      return await this.ctx.decodeAudioData(await blob.arrayBuffer());
    } catch (err) {
      const raw = await blob.arrayBuffer(); // decodeAudioData detached the first copy
      if (raw.byteLength >= 4 && isOgg(raw)) {
        return decodeVorbis(this.ctx, raw);
      }
      throw err;
    }
  }

  // dtx: parsed chart; resolveFile(path) -> Blob | null; onProgress(done, total).
  // Only WAV ids actually referenced by chips are decoded.
  // Returns { missing: [names], failed: [names] }.
  async load(dtx, resolveFile, onProgress) {
    this.clear();
    const used = new Set();
    for (const c of dtx.chips) used.add(c.wav);

    const missing = [];
    const failed = [];
    const ids = [...used];
    let done = 0;

    for (const id of ids) {
      const def = dtx.wavs.get(id);
      if (!def || !def.file) {
        missing.push(`WAV${id.toString(36).toUpperCase().padStart(2, '0')}`);
      } else {
        const blob = resolveFile(def.file);
        if (!blob) {
          missing.push(def.file);
        } else {
          try {
            const buffer = await this.decode(blob);
            this.sounds.set(id, { buffer, volume: def.volume, pan: def.pan });
          } catch {
            failed.push(def.file);
          }
        }
      }
      done++;
      onProgress?.(done, ids.length);
    }
    return { missing, failed };
  }
}
