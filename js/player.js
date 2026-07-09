// Autoplay engine + DTXMania-style lane renderer.
//
// Audio is scheduled ahead of time on a Web Audio clock (lookahead scheduler);
// the canvas renders falling notes against the same clock. All chip times are
// in "song seconds"; playSpeed stretches them onto the real-time clock
// (sources play at the matching playbackRate, so buffer time tracks song time).

import { SoundBank } from './audio.js';
import { Stretcher } from './stretch.js';

// Note types the user can color independently. Colors are kept per type even
// when lanes are grouped, so e.g. RD chips stay distinguishable on the CY lane.
export const NOTE_TYPES = [
  { key: 'LC',  label: 'Left cymbal',     ch: 0x1A, color: '#ce7cff' },
  { key: 'HH',  label: 'Hi-hat (closed)', ch: 0x11, color: '#41c8ff' },
  { key: 'OH',  label: 'Hi-hat (open)',   ch: 0x18, color: '#c2f3ff' },
  { key: 'LP',  label: 'Left pedal',      ch: 0x1B, color: '#ff5bd6' },
  { key: 'LBD', label: 'Left bass drum',  ch: 0x1C, color: '#9d8aff' },
  { key: 'SD',  label: 'Snare',           ch: 0x12, color: '#ffd23b' },
  { key: 'HT',  label: 'High tom',        ch: 0x14, color: '#4dee6f' },
  { key: 'BD',  label: 'Bass drum',       ch: 0x13, color: '#9d8aff' },
  { key: 'LT',  label: 'Low tom',         ch: 0x15, color: '#ff5252' },
  { key: 'FT',  label: 'Floor tom',       ch: 0x17, color: '#ff9030' },
  { key: 'CY',  label: 'Cymbal',          ch: 0x16, color: '#4d7bff' },
  { key: 'RD',  label: 'Ride',            ch: 0x19, color: '#6fe0e8' },
];

const CH_TYPE = new Map(NOTE_TYPES.map((t) => [t.ch, t.key]));

export function defaultColors() {
  return Object.fromEntries(NOTE_TYPES.map((t) => [t.key, t.color]));
}

// DTXMania-style display options.
export function defaultDisplay() {
  return {
    dark: 'off',          // 'off' | 'half' (no lane frames) | 'full' (chips only)
    barLines: true,       // measure lines
    beatLines: true,      // beat lines (dimmer)
    measureNumbers: true,
    hitLine: true,
    laneFlash: true,      // hit flash on the lanes
    laneOpacity: 25,      // 0-100 lane background opacity ("Lane Trans")
    reverse: false,       // notes scroll upward instead of falling
    sudden: false,        // notes appear only near the hit line
    hidden: false,        // notes vanish near the hit line
  };
}

// DTXManiaNX default drum lane order (left to right).
export const LANE_IDS = ['LC', 'HH', 'LP', 'SD', 'HT', 'BD', 'LT', 'FT', 'CY', 'RD'];

const LANE_DEF = {
  LC: { channels: [0x1A], w: 1.0 },
  HH: { channels: [0x11, 0x18], w: 1.0 },
  LP: { channels: [0x1B, 0x1C], w: 1.0 },
  SD: { channels: [0x12], w: 1.1 },
  HT: { channels: [0x14], w: 1.0 },
  BD: { channels: [0x13], w: 1.2 },
  LT: { channels: [0x15], w: 1.0 },
  FT: { channels: [0x17], w: 1.0 },
  CY: { channels: [0x16], w: 1.1 },
  RD: { channels: [0x19], w: 1.0 },
};

// DTXMania-style grouping: lane id -> [settings key, lane it merges into].
export const GROUP_RULES = {
  LC: ['lc', 'HH'], // HH group
  LP: ['lp', 'BD'], // BD group
  FT: ['ft', 'LT'], // FT group
  RD: ['rd', 'CY'], // CY group
};

// Open/close hi-hat and left pedal choke each other.
const HH_GROUP = new Set([0x11, 0x18, 0x1B]);

const LOOKAHEAD = 0.35;   // real seconds of audio scheduled ahead
const TICK_MS = 60;       // scheduler interval
const START_DELAY = 0.08; // gap between pressing play and audio start
const BASE_PPS = 260;     // scroll pixels/second at scroll speed 1.0

// At playSpeed != 1, sounds longer than this are pitch-preserving
// time-stretched (BGM, long pads). Shorter one-shots (drum hits, SE) play
// unmodified — only their trigger times change — which keeps transients and
// pitch perfect, like DTXMania's timestretch mode.
const STRETCH_MIN_SECONDS = 4;

function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Player {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');

    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    // Separate buses: drum-note keysounds vs BGM/auto-played sounds.
    this.noteGain = this.ctx.createGain();
    this.noteGain.connect(this.master);
    this.autoGain = this.ctx.createGain();
    this.autoGain.connect(this.master);
    this.bank = new SoundBank(this.ctx);
    this.stretcher = new Stretcher();
    this._stretched = new Map(); // wavId -> stretched AudioBuffer (playSpeed != 1)
    this._stretchGen = 0;
    this._chartEnd = 0;

    this.chips = [];
    this.notes = [];   // visible chips with lane index for the current grouping
    this.bars = [];
    this.duration = 0;

    this.playing = false;
    this.pausedAt = 0;
    this.startOffset = 0;
    this.ctxStart = 0;
    this.speed = 1.0;      // scroll speed (visual only)
    this.playSpeed = 1.0;  // playback tempo (audio + clock)
    this.groups = { lc: false, lp: false, ft: false, rd: false };
    this.laneOrder = [...LANE_IDS];
    this.colors = defaultColors();
    this.display = defaultDisplay();
    this.hiddenLanes = new Set();
    this.lanes = [];
    this.chToLane = new Map();
    this.beats = [];

    this._schedIdx = 0;
    this._schedTimer = null;
    this._visIdx = 0;
    this._laneFlash = [];
    this._sources = new Set();
    this._activeByWav = new Map();
    this._activeHH = new Map();

    this.onFrame = null; // (player) called every rendered frame
    this.onEnded = null;
    this.onStretchProgress = null; // (0..1) while preparing time-stretch

    // Track the canvas CSS size via ResizeObserver instead of reading
    // clientWidth/Height every frame (those force a synchronous reflow
    // whenever anything dirtied layout).
    this._cssW = 0;
    this._cssH = 0;
    this._ro = new ResizeObserver(() => {
      this._cssW = canvas.clientWidth;
      this._cssH = canvas.clientHeight;
    });
    this._ro.observe(canvas);

    this._rebuildLanes();
    this._raf = requestAnimationFrame(this._render);
  }

  get time() {
    if (!this.playing) return this.pausedAt;
    return this.startOffset + Math.max(0, this.ctx.currentTime - this.ctxStart) * this.playSpeed;
  }

  async load(dtx, resolveFile, onProgress) {
    this.pause();
    this.stopAudio();
    this.pausedAt = 0;
    const result = await this.bank.load(dtx, resolveFile, onProgress);

    this.chips = dtx.chips;
    this.bars = dtx.bars;
    this.beats = dtx.beats || [];
    this._chartEnd = dtx.chartEnd;
    this._rebuildLanes();
    await this._prepareStretched(); // also computes this.duration
    return result;
  }

  async play() {
    if (this.playing || !this.chips.length) return;
    await this.ctx.resume();
    if (this.pausedAt >= this.duration - 0.05) this.pausedAt = 0;

    this.startOffset = this.pausedAt;
    this.ctxStart = this.ctx.currentTime + START_DELAY;
    this.playing = true;
    this._resetPointers(this.startOffset);

    // Chips that started earlier but are still sounding (BGM after a seek,
    // long cymbal tails, …) restart at the right offset into their buffer.
    // song seconds -> real buffer seconds is /playSpeed for both stretched
    // buffers and unmodified one-shots.
    this._schedIdx = 0;
    for (let i = 0; i < this.chips.length; i++) {
      const c = this.chips[i];
      if (c.time >= this.startOffset) break;
      this._schedIdx = i + 1;
      const s = this.bank.get(c.wav);
      if (!s) continue;
      const buffer = this._stretched.get(c.wav) || s.buffer;
      const offset = (this.startOffset - c.time) / this.playSpeed;
      if (buffer.duration - offset > 0.05) this._playChip(c, this.ctxStart, offset);
    }

    this._schedTimer = setInterval(() => this._tick(), TICK_MS);
    this._tick();
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = Math.min(this.time, this.duration);
    this.playing = false;
    clearInterval(this._schedTimer);
    this._schedTimer = null;
    this.stopAudio();
  }

  seek(t) {
    const wasPlaying = this.playing;
    this.pause();
    this.pausedAt = Math.max(0, Math.min(t, this.duration));
    this._resetPointers(this.pausedAt);
    if (wasPlaying) this.play();
  }

  // True if changing to speed v involves (re)stretching audio — callers can
  // use this to decide whether to show a busy indicator.
  needsStretch(v = this.playSpeed) {
    if (Math.abs(v - 1) < 1e-6) return false;
    for (const [, s] of this.bank.sounds) {
      if (s.buffer.duration >= STRETCH_MIN_SECONDS) return true;
    }
    return false;
  }

  async setPlaySpeed(v) {
    v = Math.max(0.1, v);
    if (Math.abs(v - this.playSpeed) < 1e-9) return;
    const wasPlaying = this.playing;
    const t = this.time;
    if (wasPlaying) this.pause();
    this.playSpeed = v;
    const gen = this._stretchGen + 1;
    await this._prepareStretched();
    if (this._stretchGen !== gen) return; // superseded by a newer change
    if (wasPlaying) {
      this.pausedAt = Math.min(t, this.duration);
      await this.play();
    }
  }

  // Rebuild the stretched-buffer set for the current playSpeed (long sounds
  // only) and recompute the song duration.
  async _prepareStretched() {
    const gen = ++this._stretchGen;
    const speed = this.playSpeed;

    const targets = [];
    if (Math.abs(speed - 1) > 1e-6) {
      for (const [id, s] of this.bank.sounds) {
        if (s.buffer.duration >= STRETCH_MIN_SECONDS) targets.push([id, s.buffer]);
      }
    }

    const newMap = new Map();
    let done = 0;
    for (const [id, buf] of targets) {
      const channels = [];
      for (let ch = 0; ch < buf.numberOfChannels; ch++) channels.push(buf.getChannelData(ch).slice());
      const out = await this.stretcher.stretch(channels, buf.sampleRate, speed, (p) => {
        if (gen === this._stretchGen) this.onStretchProgress?.((done + p) / targets.length);
      });
      if (gen !== this._stretchGen) return; // superseded
      const nb = this.ctx.createBuffer(buf.numberOfChannels, out[0].length, buf.sampleRate);
      for (let ch = 0; ch < out.length; ch++) nb.copyToChannel(out[ch], ch);
      newMap.set(id, nb);
      done++;
      this.onStretchProgress?.(done / targets.length);
    }
    this._stretched = newMap;

    // Song length: stretched sounds still cover their original span in song
    // time; unmodified one-shots cover realDuration * speed song seconds.
    let end = this._chartEnd;
    for (const c of this.chips) {
      const s = this.bank.get(c.wav);
      if (!s) continue;
      const songLen = newMap.has(c.wav) ? s.buffer.duration : s.buffer.duration * speed;
      end = Math.max(end, c.time + songLen);
    }
    this.duration = end + 0.5;
  }

  setGroups(groups) {
    this.groups = { ...this.groups, ...groups };
    this._rebuildLanes();
  }

  // Arbitrary lane order; unknown ids are dropped, missing lanes appended in
  // default order so the chart never loses a lane.
  setLaneOrder(order) {
    const seen = new Set();
    const clean = [];
    for (const id of order || []) {
      if (LANE_DEF[id] && !seen.has(id)) { seen.add(id); clean.push(id); }
    }
    for (const id of LANE_IDS) if (!seen.has(id)) clean.push(id);
    this.laneOrder = clean;
    this._rebuildLanes();
  }

  // Per-note-type colors ({ HH: '#41c8ff', ... }); the renderer reads these
  // live, so no rebuild is needed.
  setColors(colors) {
    this.colors = { ...defaultColors(), ...colors };
  }

  // Display options (see defaultDisplay); read live by the renderer.
  setDisplay(display) {
    this.display = { ...defaultDisplay(), ...display };
  }

  // Completely hide individual lanes (their chips are not drawn; audio is
  // unaffected).
  setHiddenLanes(ids) {
    this.hiddenLanes = new Set(ids);
    this._rebuildLanes();
  }

  setVolume(v) { this.master.gain.value = v; }
  setNotesVolume(v) { this.noteGain.gain.value = v; }
  setBgmVolume(v) { this.autoGain.gain.value = v; }

  stopAudio() {
    for (const src of this._sources) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    this._sources.clear();
    this._activeByWav.clear();
    this._activeHH.clear();
  }

  destroy() {
    this.pause();
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    this.ctx.close();
  }

  _rebuildLanes() {
    // Lanes folded into another lane by grouping redirect their chips there;
    // user-hidden lanes simply drop theirs.
    const grouped = new Set();
    for (const [laneId, [key]] of Object.entries(GROUP_RULES)) {
      if (this.groups[key]) grouped.add(laneId);
    }
    const hidden = new Set([...this.hiddenLanes, ...grouped]);
    this.lanes = this.laneOrder
      .filter((id) => !hidden.has(id))
      .map((id) => ({ id, ...LANE_DEF[id] }));
    const idx = new Map(this.lanes.map((l, i) => [l.id, i]));

    this.chToLane = new Map();
    for (const id of LANE_IDS) {
      const target = grouped.has(id) ? GROUP_RULES[id][1] : id;
      for (const ch of LANE_DEF[id].channels) this.chToLane.set(ch, idx.get(target));
    }

    this.notes = [];
    for (const c of this.chips) {
      if (!c.visible) continue;
      const lane = this.chToLane.get(c.ch);
      if (lane !== undefined) this.notes.push({ time: c.time, lane, ch: c.ch });
    }
    this._laneFlash = new Array(this.lanes.length).fill(-Infinity);
    this._resetPointers(this.playing ? this.time : this.pausedAt);
  }

  _resetPointers(t) {
    this._visIdx = lowerBound(this.notes, t);
    this._laneFlash.fill(-Infinity);
  }

  _tick() {
    const now = this.time;
    if (now >= this.duration) {
      this.pause();
      this.pausedAt = this.duration;
      this.onEnded?.();
      return;
    }
    // Lookahead is real time; convert to song time.
    const horizon = now + LOOKAHEAD * this.playSpeed;
    while (this._schedIdx < this.chips.length && this.chips[this._schedIdx].time < horizon) {
      const c = this.chips[this._schedIdx++];
      this._playChip(c, this.ctxStart + (c.time - this.startOffset) / this.playSpeed, 0);
    }
  }

  _playChip(chip, when, offset) {
    const s = this.bank.get(chip.wav);
    if (!s) return;
    const at = Math.max(when, this.ctx.currentTime);

    const src = this.ctx.createBufferSource();
    // Long sounds have a pitch-preserving stretched variant at playSpeed != 1;
    // one-shots play unmodified. Both run at playbackRate 1, so pitch never
    // changes with tempo.
    src.buffer = this._stretched.get(chip.wav) || s.buffer;
    let node = src;

    const gain = this.ctx.createGain();
    gain.gain.value = (s.volume ?? 100) / 100;
    node.connect(gain);
    node = gain;

    if (s.pan) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, s.pan / 100));
      node.connect(p);
      node = p;
    }
    const isNote = chip.ch >= 0x11 && chip.ch <= 0x1C;
    node.connect(isNote ? this.noteGain : this.autoGain);

    // Re-triggering the same WAV cuts off the previous instance.
    const prev = this._activeByWav.get(chip.wav);
    if (prev) {
      try { prev.stop(at); } catch { /* already stopped */ }
    }
    this._activeByWav.set(chip.wav, src);

    // Hi-hat choke: close/open/left-pedal silence each other.
    if (HH_GROUP.has(chip.ch)) {
      for (const [wav, other] of this._activeHH) {
        if (wav !== chip.wav) {
          try { other.stop(at); } catch { /* already stopped */ }
        }
      }
      this._activeHH.clear();
      this._activeHH.set(chip.wav, src);
    }

    this._sources.add(src);
    src.onended = () => {
      this._sources.delete(src);
      if (this._activeByWav.get(chip.wav) === src) this._activeByWav.delete(chip.wav);
      if (this._activeHH.get(chip.wav) === src) this._activeHH.delete(chip.wav);
    };
    src.start(at, offset);
  }

  // ---- rendering ----

  _render = () => {
    this._raf = requestAnimationFrame(this._render);
    const cv = this.canvas, g = this.g;
    const dpr = window.devicePixelRatio || 1;
    const W = this._cssW, H = this._cssH;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const now = Math.min(this.time, this.duration);
    // Dividing by playSpeed keeps the on-screen scroll velocity constant:
    // at half tempo, notes spread out instead of crawling.
    const pps = (BASE_PPS * this.speed) / this.playSpeed;
    const disp = this.display;
    const dark = disp.dark;
    const dir = disp.reverse ? 1 : -1;      // reverse: notes scroll upward
    const hitY = disp.reverse ? 78 : H - 78;
    const span = H - 58;                    // px of visible approach distance
    const lanes = this.lanes;

    g.fillStyle = '#101018';
    g.fillRect(0, 0, W, H);

    const totalUnits = lanes.reduce((a, l) => a + l.w, 0) || 1;
    const chartW = Math.min(W - 40, 680);
    const unit = chartW / totalUnits;
    const x0 = (W - chartW) / 2;
    const yOf = (t) => hitY + dir * (t - now) * pps;

    let x = x0;
    const laneX = [];
    for (const lane of lanes) {
      laneX.push(x);
      x += lane.w * unit;
    }

    // Lane backgrounds and separators (hidden in dark half/full).
    if (dark === 'off' && lanes.length) {
      const bgAlpha = (Math.max(0, Math.min(100, disp.laneOpacity)) / 100) * 0.12;
      g.fillStyle = `rgba(255,255,255,${bgAlpha.toFixed(4)})`;
      for (let i = 0; i < lanes.length; i++) {
        g.fillRect(laneX[i] + 1, 0, lanes[i].w * unit - 2, H);
      }
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      g.lineWidth = 1;
      g.beginPath();
      x = x0;
      for (let i = 0; i <= lanes.length; i++) {
        g.moveTo(Math.round(x) + 0.5, 0);
        g.lineTo(Math.round(x) + 0.5, H);
        if (i < lanes.length) x += lanes[i].w * unit;
      }
      g.stroke();
    }

    const tMin = now - 40 / pps;
    const tMax = now + span / pps;

    if (dark !== 'full') {
      // Beat lines (dim), then measure lines + numbers on top.
      if (disp.beatLines) {
        g.strokeStyle = 'rgba(255,255,255,0.12)';
        g.lineWidth = 1;
        g.beginPath();
        for (let i = lowerBound(this.beats, tMin); i < this.beats.length; i++) {
          if (this.beats[i].time > tMax) break;
          const y = Math.round(yOf(this.beats[i].time)) + 0.5;
          g.moveTo(x0, y);
          g.lineTo(x0 + chartW, y);
        }
        g.stroke();
      }
      if (disp.barLines || disp.measureNumbers) {
        g.font = '11px sans-serif';
        for (let i = lowerBound(this.bars, tMin); i < this.bars.length; i++) {
          const bar = this.bars[i];
          if (bar.time > tMax) break;
          const y = yOf(bar.time);
          if (disp.barLines) {
            g.strokeStyle = 'rgba(255,255,255,0.35)';
            g.beginPath();
            g.moveTo(x0, Math.round(y) + 0.5);
            g.lineTo(x0 + chartW, Math.round(y) + 0.5);
            g.stroke();
          }
          if (disp.measureNumbers) {
            g.fillStyle = 'rgba(255,255,255,0.45)';
            g.textAlign = 'right';
            g.fillText(String(bar.num).padStart(3, '0'), x0 - 8, y + 4);
          }
        }
      }
      if (disp.hitLine) {
        const grad = g.createLinearGradient(0, hitY - 3, 0, hitY + 3);
        grad.addColorStop(0, 'rgba(255,80,80,0.15)');
        grad.addColorStop(0.5, '#ff4d4d');
        grad.addColorStop(1, 'rgba(255,80,80,0.15)');
        g.fillStyle = grad;
        g.fillRect(x0 - 6, hitY - 3, chartW + 12, 6);
      }
    }

    // Advance the "hit" pointer for lane flashes.
    while (this._visIdx < this.notes.length && this.notes[this._visIdx].time <= now) {
      this._laneFlash[this.notes[this._visIdx].lane] = this.notes[this._visIdx].time;
      this._visIdx++;
    }

    // Lane hit flashes.
    if (disp.laneFlash && dark !== 'full') {
      for (let i = 0; i < lanes.length; i++) {
        const dt = now - this._laneFlash[i];
        if (dt < 0.15) {
          const a = 1 - dt / 0.15;
          g.fillStyle = this.colors[lanes[i].id];
          g.globalAlpha = a * 0.55;
          const lw = lanes[i].w * unit;
          g.fillRect(laneX[i] + 2, hitY - 26, lw - 4, 52);
          g.globalAlpha = 1;
        }
      }
    }

    // Notes. Chips merged in from a grouped lane keep their own color and
    // draw slightly inset so they read as "foreign" on the target lane.
    const noteH = 11;
    for (let i = lowerBound(this.notes, tMin); i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time > tMax) break;
      if (n.time > now) {
        // Sudden: appear only near the line; Hidden: vanish near the line.
        const approach = (n.time - now) * pps; // px from the hit line
        if (disp.sudden && approach > span * 0.4) continue;
        if (disp.hidden && approach < span * 0.25) continue;
      }
      const y = yOf(n.time);
      const lane = lanes[n.lane];
      const foreign = !lane.channels.includes(n.ch);
      const inset = foreign ? Math.round(lane.w * unit * 0.12) : 0;
      const lx = laneX[n.lane] + 3 + inset;
      const lw = lane.w * unit - 6 - inset * 2;
      const color = this.colors[CH_TYPE.get(n.ch)] || this.colors[lane.id];
      if (n.ch === 0x18) {
        // Open hi-hat: hollow note.
        g.strokeStyle = color;
        g.lineWidth = 2.5;
        g.strokeRect(lx + 1, y - noteH / 2 + 1, lw - 2, noteH - 2);
      } else {
        g.fillStyle = color;
        g.fillRect(lx, y - noteH / 2, lw, noteH);
        g.fillStyle = 'rgba(255,255,255,0.45)';
        g.fillRect(lx, y - noteH / 2, lw, 2);
      }
    }

    // Lane labels sit just past the hit line.
    if (dark === 'off') {
      g.font = 'bold 12px sans-serif';
      g.textAlign = 'center';
      const labelY = disp.reverse ? hitY - 32 : hitY + 32;
      for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i];
        g.fillStyle = this.colors[lane.id];
        g.fillText(lane.id, laneX[i] + lane.w * unit / 2, labelY);
      }
    }

    this.onFrame?.(this);
  };
}
