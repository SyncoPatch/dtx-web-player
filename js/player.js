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

export const CH_TYPE = new Map(NOTE_TYPES.map((t) => [t.ch, t.key]));

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

export const LANE_DEF = {
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

// Resolve the visible lanes and channel->lane-index map for a given lane order,
// grouping, and hidden-lane set. Pure (no `this`) so the static chart viewer
// (chartview.js) and the live highway (_rebuildLanes) share identical lane
// resolution. Returns { lanes: [{id, channels, w}], chToLane: Map<ch, idx> }.
export function buildLanes({ laneOrder = LANE_IDS, groups = {}, hiddenLanes = new Set() } = {}) {
  const grouped = new Set();
  for (const [laneId, [key]] of Object.entries(GROUP_RULES)) {
    if (groups[key]) grouped.add(laneId);
  }
  const hidden = new Set([...hiddenLanes, ...grouped]);
  const lanes = laneOrder
    .filter((id) => !hidden.has(id))
    .map((id) => ({ id, ...LANE_DEF[id] }));
  const idx = new Map(lanes.map((l, i) => [l.id, i]));
  const chToLane = new Map();
  for (const id of LANE_IDS) {
    const target = grouped.has(id) ? GROUP_RULES[id][1] : id;
    for (const ch of LANE_DEF[id].channels) chToLane.set(ch, idx.get(target));
  }
  return { lanes, chToLane };
}

// ---- drum tab (sheet notation) ----
// Staff positions in half-steps from the top staff line (even = on a line).
// Hands are stemmed/beamed upward, feet downward, like standard kit notation.
// (Exported for the PDF score engine in score.js.)
export const TAB_HANDS = new Map([
  [0x1A, -4], // LC: high ledger
  [0x16, -2], // CY: ledger above staff
  [0x11, -1], [0x18, -1], // HH closed/open: above top line
  [0x19, 0],  // RD: top line
  [0x14, 1],  // HT
  [0x15, 2],  // LT
  [0x12, 3],  // SD
  [0x17, 5],  // FT
]);
export const TAB_FEET = new Map([
  [0x13, 7], [0x1C, 7], // BD / LBD: bottom space
  [0x1B, 9],            // LP: below the staff
]);
export const TAB_XHEAD = new Set([0x1A, 0x16, 0x11, 0x18, 0x19, 0x1B]); // cymbals & pedal
const TAB_PPS = 150;     // horizontal px/second at scroll speed 1.0
const TAB_GAP = 12;      // staff line spacing
const TAB_STRIP_H = 170; // height of the tab strip above/below the lanes

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
    // iOS unlocks audio only inside a user gesture. The Player is created in
    // a click/tap handler, so resume immediately and play one silent frame.
    this.ctx.resume().catch(() => {});
    try {
      const unlock = this.ctx.createBufferSource();
      unlock.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      unlock.connect(this.ctx.destination);
      unlock.start(0);
    } catch { /* not fatal */ }
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
    this.globalOffset = 0; // display-audio offset in real seconds (visual
                           // only): positive shifts notes later to compensate
                           // for audio output latency
    this.chartOffset = 0;  // per-chart correction in song seconds
    this.tabPos = 'off';   // tab strip position: 'off' | 'top' | 'bottom'
    this.tabZoom = 1;      // tab horizontal zoom (0.25..4)
    this._tabScroll = 0;   // paused-view scroll offset in song seconds
    this._tabDrag = null;  // { mode, anchorT, lastX, ... } during strip drags
    this._tabPointers = new Map(); // active touch pointers on the strip
    this._pinch = null;    // { d0, z0 } during two-finger pinch zoom
    this.loop = null;      // { startIdx, endIdx, startNum, endNum, startTime, endTime }
    this._tab = { cols: [], groups: [] };
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
    this.onLoopChange = null; // (loop | null) after loop edits
    this.onTabZoom = null; // (zoom) after wheel/pinch zoom on the strip

    // Tab strip interactions.
    // Mouse: click seeks / toggles the loop region; drag (paused) paints a
    //   measure-snapped loop; edge grips resize; wheel scrolls; ctrl+wheel
    //   zooms.
    // Touch: tap seeks / toggles; one-finger drag (paused) pans the view;
    //   press-and-hold then drag paints a loop; two-finger pinch zooms;
    //   edge grips (wider hit area) resize immediately.
    const inStrip = (e) => {
      const r = this._tabRegion();
      return r && e.offsetY >= r.top && e.offsetY <= r.top + r.h ? r : null;
    };
    const startResize = (edge) => {
      // Resize: the opposite boundary stays fixed; anchoring inside its
      // measure lets a drag past the other edge flip naturally.
      const L = this.loop;
      return {
        mode: 'resize',
        anchorT: this.bars[edge === 'start' ? L.endIdx : L.startIdx].time,
        keepEnabled: L.enabled,
      };
    };
    const clearDrag = () => {
      if (this._tabDrag?.timer) clearTimeout(this._tabDrag.timer);
      this._tabDrag = null;
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (!inStrip(e) || !this.bars.length) return;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      const touch = e.pointerType === 'touch';

      if (touch) {
        this._tabPointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
        if (this._tabPointers.size === 2) {
          // Second finger: switch to pinch-zoom, abandon any drag.
          clearDrag();
          const [a, b] = [...this._tabPointers.values()];
          this._pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: this.tabZoom };
          return;
        }
        if (this._tabPointers.size > 2) return;
      }

      const edge = this._loopEdgeAt(e.offsetX, touch ? 16 : 7);
      const base = { lastX: e.offsetX, startX: e.offsetX, touch, timer: 0 };
      if (edge && !this.playing) {
        this._tabDrag = { ...base, ...startResize(edge) };
      } else {
        const d = {
          ...base,
          mode: 'pending',
          anchorT: this._tabTimeAt(e.offsetX),
          keepEnabled: true,
          startScroll: this._tabScroll,
        };
        if (touch && !this.playing) {
          // Press-and-hold turns the pending tap into loop painting.
          d.timer = setTimeout(() => {
            if (this._tabDrag === d && d.mode === 'pending' && !this.playing) {
              d.mode = 'paint';
              this._loopFromTimes(d.anchorT, d.anchorT, true);
            }
          }, 400);
        }
        this._tabDrag = d;
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' && this._tabPointers.has(e.pointerId)) {
        this._tabPointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
        if (this._pinch && this._tabPointers.size >= 2) {
          const [a, b] = [...this._tabPointers.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          this.setTabZoom(this._pinch.z0 * (dist / this._pinch.d0));
          this.onTabZoom?.(this.tabZoom);
          return;
        }
      }
      const d = this._tabDrag;
      if (!d) {
        if (e.pointerType !== 'touch') {
          canvas.style.cursor = inStrip(e)
            ? (this._loopEdgeAt(e.offsetX) ? 'ew-resize' : 'pointer')
            : '';
        }
        return;
      }
      d.lastX = e.offsetX;
      if (d.mode === 'pending' && Math.abs(e.offsetX - d.startX) > (d.touch ? 8 : 5)) {
        clearTimeout(d.timer);
        if (!this.playing) d.mode = d.touch ? 'pan' : 'paint';
      }
      if (d.mode === 'pan') {
        this._tabScroll = d.startScroll - (e.offsetX - d.startX) / this._tabPps();
        this._clampTabScroll();
      } else if (d.mode === 'paint' || d.mode === 'resize') {
        this._loopFromTimes(d.anchorT, this._tabTimeAt(e.offsetX), d.keepEnabled);
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') {
        this._tabPointers.delete(e.pointerId);
        if (this._tabPointers.size < 2) this._pinch = null;
      }
      const d = this._tabDrag;
      if (!d) return;
      clearDrag();
      if (d.mode !== 'pending') return;
      // Plain click/tap: inside the loop region toggles it; elsewhere seeks
      // to the start of the clicked measure.
      const t = this._tabTimeAt(e.offsetX);
      if (this.loop && t >= this.loop.startTime && t < this.loop.endTime) {
        this.toggleLoop();
        return;
      }
      if (t >= 0 && t < this.duration) {
        let idx = lowerBound(this.bars, t + 1e-9) - 1;
        if (idx < 0) idx = 0;
        this.seek(this.bars[idx].time);
      }
    });
    canvas.addEventListener('pointercancel', (e) => {
      this._tabPointers.delete(e.pointerId);
      if (this._tabPointers.size < 2) this._pinch = null;
      clearDrag();
    });
    canvas.addEventListener('wheel', (e) => {
      if (!inStrip(e)) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { // pinch gestures arrive as ctrl+wheel
        this.setTabZoom(this.tabZoom * Math.exp(-e.deltaY * 0.0015));
        this.onTabZoom?.(this.tabZoom);
      } else if (!this.playing) {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this._tabScroll += delta / this._tabPps();
        this._clampTabScroll();
      }
    }, { passive: false });

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
    this.loop = null;
    this.onLoopChange?.(null);
    this._rebuildLanes();
    this._buildTab();
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
    this._tabScroll = 0; // resume following the playhead
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
    this._tabScroll = 0;
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

  // Display-audio offsets in seconds; only the renderer's clock shifts, audio
  // scheduling is untouched. globalSec is real time, chartSec is song time.
  setOffset(globalSec, chartSec = 0) {
    this.globalOffset = globalSec;
    this.chartOffset = chartSec;
  }

  // Effective display offset in song seconds. Global offset compensates
  // real-time audio latency, so it scales with playSpeed; chart offset
  // corrects chart-vs-recording misalignment, which lives in song time.
  get offset() {
    return this.globalOffset * this.playSpeed + this.chartOffset;
  }

  setTabPos(pos) {
    this.tabPos = pos === 'top' || pos === 'bottom' ? pos : 'off';
    if (this.tabPos === 'off') this.canvas.style.cursor = '';
  }

  setTabZoom(z) {
    this.tabZoom = Math.max(0.25, Math.min(4, z));
  }

  _tabPps() {
    return TAB_PPS * this.tabZoom;
  }

  // Song time under canvas x, honoring the paused-view scroll offset.
  _tabTimeAt(x) {
    const now = Math.min(this.time - this.offset, this.duration);
    const viewT = now + this._tabScroll;
    return viewT + (x - this._cssW * 0.25) / this._tabPps();
  }

  _clampTabScroll() {
    const now = Math.min(this.time - this.offset, this.duration);
    this._tabScroll = Math.max(-now - 1, Math.min(this.duration - now + 1, this._tabScroll));
  }

  // Measure-snapped loop between two song times (either order).
  _loopFromTimes(t1, t2, enabled = true) {
    const idxOf = (t) => {
      let i = lowerBound(this.bars, Math.max(0, t) + 1e-9) - 1;
      return Math.max(0, Math.min(i, this.bars.length - 1));
    };
    this.setLoop(idxOf(Math.min(t1, t2)), idxOf(Math.max(t1, t2)), enabled);
  }

  // Canvas x of a song time in the tab strip's current view.
  _tabXOf(t) {
    const now = Math.min(this.time - this.offset, this.duration);
    return this._cssW * 0.25 + (t - (now + this._tabScroll)) * this._tabPps();
  }

  // 'start' | 'end' when x is within grabbing range of a loop edge.
  _loopEdgeAt(x, range = 7) {
    if (!this.loop || this.playing) return null;
    if (Math.abs(x - this._tabXOf(this.loop.startTime)) <= range) return 'start';
    if (Math.abs(x - this._tabXOf(this.loop.endTime)) <= range) return 'end';
    return null;
  }

  // Tab strip rectangle in CSS px, or null when hidden / canvas too short.
  _tabRegion() {
    if (this.tabPos === 'off') return null;
    const H = this._cssH;
    if (!H || H < TAB_STRIP_H + 160) return null;
    return { top: this.tabPos === 'top' ? 0 : H - TAB_STRIP_H, h: TAB_STRIP_H };
  }

  // Practice loop over whole measures (bar indices, inclusive). A disabled
  // loop keeps its region (drawn grey) but does not affect playback.
  setLoop(startIdx, endIdx, enabled = true) {
    const last = this.bars.length - 1;
    if (last < 0) return;
    const a = Math.max(0, Math.min(startIdx, last));
    const b = Math.max(a, Math.min(endIdx, last));
    this.loop = {
      startIdx: a,
      endIdx: b,
      startNum: this.bars[a].num,
      endNum: this.bars[b].num,
      startTime: this.bars[a].time,
      endTime: this.bars[b + 1]?.time ?? this.duration,
      enabled,
    };
    this.onLoopChange?.(this.loop);
  }

  toggleLoop() {
    if (!this.loop) return;
    this.loop = { ...this.loop, enabled: !this.loop.enabled };
    this.onLoopChange?.(this.loop);
  }

  clearLoop() {
    this.loop = null;
    this.onLoopChange?.(null);
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
    // user-hidden lanes simply drop theirs. Shared with the static chart viewer.
    const { lanes, chToLane } = buildLanes({
      laneOrder: this.laneOrder,
      groups: this.groups,
      hiddenLanes: this.hiddenLanes,
    });
    this.lanes = lanes;
    this.chToLane = chToLane;

    this.notes = [];
    for (const c of this.chips) {
      if (!c.visible) continue;
      const lane = this.chToLane.get(c.ch);
      if (lane !== undefined) this.notes.push({ time: c.time, lane, ch: c.ch });
    }
    this._laneFlash = new Array(this.lanes.length).fill(-Infinity);
    this._resetPointers(this.playing ? this.time : this.pausedAt);
  }

  // Precompute notation columns (simultaneous chips) and beam groups.
  // Beaming: hands and feet are grouped per beat; adjacent columns closer
  // than a 16th get a double beam, up to a dotted-8th gap a single beam.
  _buildTab() {
    const cols = [];
    let cur = null;
    for (const c of this.chips) {
      if (!c.visible) continue;
      const hp = TAB_HANDS.get(c.ch);
      const fp = TAB_FEET.get(c.ch);
      if (hp === undefined && fp === undefined) continue;
      if (!cur || c.time - cur.time > 1e-4) {
        cur = { time: c.time, hands: [], feet: [] };
        cols.push(cur);
      }
      if (hp !== undefined) cur.hands.push({ ch: c.ch, p: hp });
      else cur.feet.push({ ch: c.ch, p: fp });
    }

    // Beat boundaries = measure starts + beat lines.
    const bounds = [...this.bars.map((b) => b.time), ...this.beats.map((b) => b.time)]
      .sort((a, b) => a - b);
    const beatIdx = (t) => {
      let lo = 0, hi = bounds.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bounds[mid] <= t + 1e-9) lo = mid + 1;
        else hi = mid;
      }
      return lo - 1;
    };
    const beatDur = (bi) =>
      (bi >= 0 && bi + 1 < bounds.length) ? bounds[bi + 1] - bounds[bi]
        : (bounds.length > 1 ? bounds[bounds.length - 1] - bounds[bounds.length - 2] : 0.5);

    const groups = [];
    for (const voice of ['hands', 'feet']) {
      let g = null;
      for (let i = 0; i < cols.length; i++) {
        if (!cols[i][voice].length) continue;
        const bi = beatIdx(cols[i].time);
        if (g && g.beat === bi) {
          const prev = cols[g.cols[g.cols.length - 1]].time;
          const gap = cols[i].time - prev;
          const D = beatDur(bi);
          if (gap <= 0.751 * D) {
            g.pairBeams.push(gap <= 0.26 * D ? 2 : 1);
            g.cols.push(i);
            continue;
          }
        }
        g = { voice, beat: bi, cols: [i], pairBeams: [], start: cols[i].time };
        groups.push(g);
      }
    }
    groups.sort((a, b) => a.start - b.start);
    this._tab = { cols, groups };
  }

  _resetPointers(t) {
    // The flash pointer tracks the (offset-shifted) display clock.
    this._visIdx = lowerBound(this.notes, t - this.offset);
    this._laneFlash.fill(-Infinity);
  }

  _tick() {
    const now = this.time;
    if (this.loop?.enabled && now >= this.loop.endTime - 0.005) {
      this.seek(this.loop.startTime);
      return;
    }
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

    const now = Math.min(this.time - this.offset, this.duration);

    g.fillStyle = '#101018';
    g.fillRect(0, 0, W, H);

    // Optional tab strip at the top or bottom; the lanes take the rest.
    const region = this._tabRegion();
    let laneTop = 0, laneBot = H;
    if (region) {
      if (this.tabPos === 'top') laneTop = region.h;
      else laneBot = region.top;
    }

    this._renderLanes(g, W, laneTop, laneBot, now);

    if (region) {
      g.save();
      g.beginPath();
      g.rect(0, region.top, W, region.h);
      g.clip();
      this._renderTab(g, W, region.top, region.h, now);
      g.restore();
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(0, this.tabPos === 'top' ? region.h - 1 : region.top, W, 1);
    }

    this.onFrame?.(this);
  };

  // Falling-notes lanes, rendered into the [y0, y1) band.
  _renderLanes(g, W, y0, y1, now) {
    const RH = y1 - y0;
    if (RH < 40) return;
    // Dividing by playSpeed keeps the on-screen scroll velocity constant:
    // at half tempo, notes spread out instead of crawling.
    const pps = (BASE_PPS * this.speed) / this.playSpeed;
    const disp = this.display;
    const dark = disp.dark;
    const dir = disp.reverse ? 1 : -1;      // reverse: notes scroll upward
    const hitY = disp.reverse ? y0 + 78 : y1 - 78;
    const span = RH - 58;                   // px of visible approach distance
    const lanes = this.lanes;

    g.save();
    g.beginPath();
    g.rect(0, y0, W, RH);
    g.clip();

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
        g.fillRect(laneX[i] + 1, y0, lanes[i].w * unit - 2, RH);
      }
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      g.lineWidth = 1;
      g.beginPath();
      x = x0;
      for (let i = 0; i <= lanes.length; i++) {
        g.moveTo(Math.round(x) + 0.5, y0);
        g.lineTo(Math.round(x) + 0.5, y1);
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
        if (dt >= 0 && dt < 0.15) {
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

    g.restore();
  }

  // Drum sheet notation strip (drum-game style): a five-line staff scrolls
  // right-to-left past a fixed playhead. Rendered into [yTop, yTop+tabH).
  _renderTab(g, W, yTop, tabH, now) {
    const ppsH = this._tabPps();
    const playheadX = Math.round(W * 0.25);

    // Edge auto-scroll while dragging a loop selection past either side.
    const drag = this._tabDrag;
    if ((drag?.mode === 'paint' || drag?.mode === 'resize') && !this.playing) {
      const margin = 44;
      let push = 0;
      if (drag.lastX < margin) push = drag.lastX - margin;
      else if (drag.lastX > W - margin) push = drag.lastX - (W - margin);
      if (push) {
        this._tabScroll += Math.max(-60, Math.min(60, push)) * 0.15 / ppsH;
        this._clampTabScroll();
        this._loopFromTimes(drag.anchorT, this._tabTimeAt(drag.lastX), drag.keepEnabled);
      }
    }

    if (this.playing) this._tabScroll = 0;
    const viewT = now + this._tabScroll;
    const G = TAB_GAP;
    const staffTop = Math.round(yTop + 60);
    const yOfP = (p) => staffTop + (p * G) / 2;
    const xOf = (t) => playheadX + (t - viewT) * ppsH;
    const tMin = viewT - playheadX / ppsH - 0.5;
    const tMax = viewT + (W - playheadX) / ppsH + 0.5;

    // Practice-loop highlight (grey while temporarily disabled). Edge
    // handles hint that the boundaries are draggable.
    if (this.loop) {
      const on = this.loop.enabled;
      const xa = Math.max(0, xOf(this.loop.startTime));
      const xb = Math.min(W, xOf(this.loop.endTime));
      if (xb > xa) {
        g.fillStyle = on ? 'rgba(77,163,255,0.10)' : 'rgba(165,165,180,0.08)';
        g.fillRect(xa, yTop + 4, xb - xa, tabH - 8);
      }
      g.fillStyle = on ? 'rgba(77,163,255,0.55)' : 'rgba(165,165,180,0.45)';
      for (const x of [xOf(this.loop.startTime), xOf(this.loop.endTime)]) {
        if (x >= -8 && x <= W + 8) {
          g.fillRect(Math.round(x) - 1, yTop + 4, 2, tabH - 8);
          g.fillRect(Math.round(x) - 3, yTop + tabH / 2 - 12, 6, 24); // grip
        }
      }
    }

    // Staff lines.
    g.strokeStyle = 'rgba(255,255,255,0.45)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < 5; i++) {
      const y = Math.round(yOfP(i * 2)) + 0.5;
      g.moveTo(0, y);
      g.lineTo(W, y);
    }
    g.stroke();

    // Bar lines and measure numbers.
    g.font = '11px sans-serif';
    g.textAlign = 'center';
    for (let i = lowerBound(this.bars, tMin); i < this.bars.length; i++) {
      const bar = this.bars[i];
      if (bar.time > tMax) break;
      const x = Math.round(xOf(bar.time)) + 0.5;
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.beginPath();
      g.moveTo(x, yOfP(0));
      g.lineTo(x, yOfP(8));
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.45)';
      g.fillText(String(bar.num).padStart(3, '0'), x, yOfP(8) + 2.2 * G);
    }
    // Beat ticks.
    if (this.display.beatLines) {
      g.strokeStyle = 'rgba(255,255,255,0.15)';
      g.beginPath();
      for (let i = lowerBound(this.beats, tMin); i < this.beats.length; i++) {
        if (this.beats[i].time > tMax) break;
        const x = Math.round(xOf(this.beats[i].time)) + 0.5;
        g.moveTo(x, yOfP(0));
        g.lineTo(x, yOfP(8));
      }
      g.stroke();
    }

    // Playhead at its true song position (off-center while scrolled).
    const phX = xOf(now);
    if (phX >= -2 && phX <= W + 2) {
      g.fillStyle = '#ff4d4d';
      g.fillRect(Math.round(phX) - 1, yTop + 4, 2, tabH - 28);
    }

    const { cols, groups } = this._tab;

    // Note heads (with ledger lines) per column.
    const headR = 4.6;
    for (let i = lowerBound(cols, tMin); i < cols.length; i++) {
      const col = cols[i];
      if (col.time > tMax) break;
      const x = xOf(col.time);
      for (const list of [col.hands, col.feet]) {
        for (const n of list) {
          const y = yOfP(n.p);
          const color = this.colors[CH_TYPE.get(n.ch)] || '#fff';
          // Ledger lines above the staff for cymbal positions.
          if (n.p <= -2) {
            g.strokeStyle = 'rgba(255,255,255,0.4)';
            g.lineWidth = 1;
            g.beginPath();
            for (let lp = -2; lp >= n.p; lp -= 2) {
              g.moveTo(x - 8, Math.round(yOfP(lp)) + 0.5);
              g.lineTo(x + 8, Math.round(yOfP(lp)) + 0.5);
            }
            g.stroke();
          }
          if (TAB_XHEAD.has(n.ch)) {
            g.strokeStyle = color;
            g.lineWidth = 2;
            g.beginPath();
            g.moveTo(x - headR, y - headR);
            g.lineTo(x + headR, y + headR);
            g.moveTo(x - headR, y + headR);
            g.lineTo(x + headR, y - headR);
            g.stroke();
            if (n.ch === 0x18) { // open hi-hat: small ring above
              g.beginPath();
              g.arc(x, y - G - 2, 2.6, 0, Math.PI * 2);
              g.stroke();
            }
          } else {
            g.fillStyle = color;
            g.beginPath();
            g.ellipse(x, y, headR + 0.8, headR - 0.6, -0.3, 0, Math.PI * 2);
            g.fill();
          }
        }
      }
    }

    // Stems and beams per group. Groups are sorted by start time and span at
    // most one beat, so start the scan a few seconds early.
    const stemLen = 2.8 * G;
    let gLo = 0, gHi = groups.length;
    while (gLo < gHi) {
      const mid = (gLo + gHi) >> 1;
      if (groups[mid].start < tMin - 8) gLo = mid + 1;
      else gHi = mid;
    }
    for (let gi = gLo; gi < groups.length; gi++) {
      const grp = groups[gi];
      if (grp.start > tMax) break;
      const lastCol = cols[grp.cols[grp.cols.length - 1]];
      if (lastCol.time < tMin) continue;
      const up = grp.voice === 'hands';
      const stemDx = up ? headR + 0.5 : -headR - 0.5;

      // Beam height: past the outermost head of the whole group.
      let extreme = up ? Infinity : -Infinity;
      for (const ci of grp.cols) {
        for (const n of cols[ci][grp.voice]) {
          const y = yOfP(n.p);
          extreme = up ? Math.min(extreme, y) : Math.max(extreme, y);
        }
      }
      const yBeam = up ? extreme - stemLen : extreme + stemLen;

      // Stems: from the innermost head of each column to the beam.
      g.strokeStyle = 'rgba(235,235,245,0.9)';
      g.lineWidth = 1.6;
      g.beginPath();
      const stemXs = [];
      for (const ci of grp.cols) {
        const col = cols[ci];
        let inner = up ? -Infinity : Infinity;
        for (const n of col[grp.voice]) {
          const y = yOfP(n.p);
          inner = up ? Math.max(inner, y) : Math.min(inner, y);
        }
        const sx = xOf(col.time) + stemDx;
        stemXs.push(sx);
        g.moveTo(sx, inner);
        g.lineTo(sx, yBeam);
      }
      g.stroke();

      // Beams.
      if (grp.cols.length > 1) {
        g.fillStyle = 'rgba(235,235,245,0.9)';
        const dirY = up ? 1 : -1;
        g.fillRect(stemXs[0] - 0.8, up ? yBeam : yBeam - 3, stemXs[stemXs.length - 1] - stemXs[0] + 1.6, 3);
        for (let k = 0; k < grp.pairBeams.length; k++) {
          if (grp.pairBeams[k] >= 2) {
            const y2 = yBeam + dirY * 5;
            g.fillRect(stemXs[k] - 0.8, up ? y2 : y2 - 3, stemXs[k + 1] - stemXs[k] + 1.6, 3);
          }
        }
      }
    }
  }
}
