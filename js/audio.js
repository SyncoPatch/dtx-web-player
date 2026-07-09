// Decodes the WAV definitions referenced by a chart into AudioBuffers.

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
            const buffer = await this.ctx.decodeAudioData(await blob.arrayBuffer());
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
