// A small synthesized drum kit for charts that have no samples of their own
// (Guitar Pro imports). Each piece is rendered once with OfflineAudioContext
// and encoded as 16-bit PCM WAV, so the chart plays through the normal
// SoundBank path and can be stored with the song like any keysound.
//
// It is meant as a clear, usable preview of the part, not a realistic kit.

const RATE = 44100;

// Deterministic noise, so every import produces the same kit.
function noiseBuffer(ctx, seconds) {
  const buf = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 0x2545f491;
  for (let i = 0; i < d.length; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
  }
  return buf;
}

function env(ctx, node, peak, attack, decay, t0 = 0) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.setTargetAtTime(0, t0 + attack, decay / 4);
  node.connect(g);
  return g;
}

function filter(ctx, node, type, frequency, Q = 0.7) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  node.connect(f);
  return f;
}

function noise(ctx, seconds) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, seconds);
  src.start(0);
  return src;
}

// Pitch-swept sine: kick and toms.
function drum(ctx, out, { from, to, sweep, decay, level, click = 0 }) {
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(from, 0);
  osc.frequency.exponentialRampToValueAtTime(to, sweep);
  osc.start(0);
  env(ctx, osc, level, 0.002, decay).connect(out);
  if (click) env(ctx, filter(ctx, noise(ctx, 0.03), 'highpass', 2500), click, 0.001, 0.015).connect(out);
}

// Inharmonic square partials (the classic 808 cymbal recipe): hi-hats, cymbals.
function metal(ctx, base) {
  const sum = ctx.createGain();
  sum.gain.value = 1 / 6;
  for (const r of [2, 3, 4.16, 5.43, 6.79, 8.21]) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = base * r;
    o.start(0);
    o.connect(sum);
  }
  return sum;
}

function cymbal(ctx, out, { base, hp, decay, level, noiseLevel, bell = 0 }) {
  const m = filter(ctx, filter(ctx, metal(ctx, base), 'bandpass', 9000, 0.5), 'highpass', hp);
  env(ctx, m, level, 0.001, decay).connect(out);
  const n = filter(ctx, noise(ctx, decay + 0.1), 'highpass', hp);
  env(ctx, n, noiseLevel, 0.001, decay).connect(out);
  if (bell) {
    const o = ctx.createOscillator();
    o.frequency.value = 2400;
    o.start(0);
    env(ctx, o, bell, 0.001, 0.6).connect(out);
  }
}

// channel -> [file name, seconds, render(ctx, out)]
const PIECES = new Map([
  [0x13, ['bd.wav', 0.5, (c, o) => drum(c, o, { from: 160, to: 48, sweep: 0.09, decay: 0.45, level: 1, click: 0.3 })]],
  [0x12, ['sd.wav', 0.4, (c, o) => {
    drum(c, o, { from: 260, to: 180, sweep: 0.05, decay: 0.12, level: 0.55 });
    env(c, filter(c, noise(c, 0.4), 'highpass', 1200), 0.8, 0.001, 0.22).connect(o);
  }]],
  [0x14, ['ht.wav', 0.6, (c, o) => drum(c, o, { from: 330, to: 210, sweep: 0.12, decay: 0.45, level: 0.85, click: 0.12 })]],
  [0x15, ['lt.wav', 0.7, (c, o) => drum(c, o, { from: 250, to: 150, sweep: 0.14, decay: 0.55, level: 0.85, click: 0.12 })]],
  [0x17, ['ft.wav', 0.8, (c, o) => drum(c, o, { from: 180, to: 95, sweep: 0.16, decay: 0.65, level: 0.9, click: 0.12 })]],
  [0x11, ['hhc.wav', 0.15, (c, o) => cymbal(c, o, { base: 205, hp: 7000, decay: 0.06, level: 0.7, noiseLevel: 0.25 })]],
  [0x18, ['hho.wav', 0.7, (c, o) => cymbal(c, o, { base: 205, hp: 6500, decay: 0.5, level: 0.6, noiseLevel: 0.25 })]],
  [0x1B, ['hhp.wav', 0.12, (c, o) => cymbal(c, o, { base: 190, hp: 5000, decay: 0.04, level: 0.45, noiseLevel: 0.2 })]],
  [0x16, ['cy.wav', 2.0, (c, o) => cymbal(c, o, { base: 230, hp: 3500, decay: 1.7, level: 0.45, noiseLevel: 0.55 })]],
  [0x1A, ['lc.wav', 2.0, (c, o) => cymbal(c, o, { base: 260, hp: 4000, decay: 1.5, level: 0.45, noiseLevel: 0.5 })]],
  [0x19, ['rd.wav', 1.4, (c, o) => cymbal(c, o, { base: 330, hp: 5000, decay: 1.2, level: 0.35, noiseLevel: 0.12, bell: 0.08 })]],
]);

// Peak-normalized gain per piece, roughly balancing the kit.
const LEVELS = { 0x13: 0.95, 0x12: 0.85, 0x14: 0.8, 0x15: 0.8, 0x17: 0.8, 0x11: 0.45, 0x18: 0.5, 0x1B: 0.4, 0x16: 0.6, 0x1A: 0.6, 0x19: 0.5 };

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function renderPiece(ch) {
  const [, seconds, render] = PIECES.get(ch);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, Math.ceil(seconds * RATE), RATE);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  render(ctx, out);
  const data = (await ctx.startRendering()).getChannelData(0);

  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  const gain = peak > 0 ? LEVELS[ch] / peak : 0;
  // Short fade-out so a piece cut at its buffer end never clicks.
  const fade = Math.min(data.length, Math.round(0.01 * RATE));
  for (let i = 0; i < data.length; i++) {
    const tail = data.length - i;
    data[i] *= gain * (tail < fade ? tail / fade : 1);
  }
  return encodeWav(data, RATE);
}

let kit = null;

// Map<channel, { file, blob }>, rendered once per page load.
export function renderDrumKit() {
  kit ??= (async () => {
    const out = new Map();
    for (const [ch, [file]] of PIECES) out.set(ch, { file: 'kit/' + file, blob: await renderPiece(ch) });
    return out;
  })().catch((err) => { kit = null; throw err; });
  return kit;
}
