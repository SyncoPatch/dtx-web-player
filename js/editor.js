// Chart editor canvas: a DTXCreator-style vertical grid (time runs upward),
// drawn from a chartdoc.js document. Pen places / removes notes on a snap
// grid; Select picks (click, shift-click, rectangle) and drags notes in time
// and across lanes; copy / paste, keyboard nudges and undo / redo. Touch:
// one finger edits, two fingers scroll and pinch-zoom; dragging the measure
// gutter scrolls, tapping it moves the playhead.

import { LANE_IDS, LANE_DEF, CH_TYPE, defaultColors } from './player.js';
import {
  timing, measureCount, measureStarts, lenOf, positionAt, addEvents, removeEvents, shiftEvents,
  commonWav, extend, fracValue, DRUM_CHANNELS,
} from './chartdoc.js';

export const GRIDS = [4, 8, 12, 16, 24, 32, 48, 64, 96, 192]; // steps per whole note
const FINE = 3840;           // moves keep off-grid offsets (divisible by 2^8, 3, 5)
const GUTTER = 76;           // measure numbers, lengths, BPM
const FOOT = 28;             // lane labels
const LANE_PX = 40;          // per width unit
const BGM_W = 30;
const NOTE_H = 8;
const EXTRA_MEASURES = 4;    // empty room after the last measure
const UNDO_MAX = 200;
// Lanes that hold two note types: [primary, alternate].
const LANE_TYPES = { HH: [0x11, 0x18], LP: [0x1B, 0x1C] };
const TYPE_NAME = { 0x11: 'HH', 0x18: 'OH', 0x1B: 'LP', 0x1C: 'LBD' };

const keyOf = (e) => `${e.m}:${e.ch}:${e.pos.n}/${e.pos.d}:${e.val}`;

export class Editor {
  constructor(canvas, { colors = defaultColors(), laneOrder = LANE_IDS, onChange, onSeek, onStatus } = {}) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.colors = colors;
    this.onChange = onChange;
    this.onSeek = onSeek;
    this.onStatus = onStatus;
    this.grid = 16;
    this.ppb = 44;           // pixels per beat
    this.tool = 'pen';
    this.alt = { HH: false, LP: false };
    this.doc = null;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.sel = new Set();
    this.scrollBeat = -0.5;  // beat at the bottom edge of the grid
    this.playBeat = null;
    this.cursorBeat = 0;     // where Paste goes
    this.lastVal = null;
    this._drag = null;
    this._pointers = new Map();
    this._hover = null;
    this._clip = null;
    this.setLaneOrder(laneOrder);

    this._ro = new ResizeObserver(() => this.invalidate());
    this._ro.observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e, true));
    canvas.addEventListener('pointerleave', () => { this._hover = null; this.invalidate(); });
    canvas.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setLaneOrder(order) {
    this.lanes = order.filter((id) => LANE_DEF[id]).map((id) => ({ id, ...LANE_DEF[id] }));
    this.chLane = new Map();
    this.lanes.forEach((l, i) => l.channels.forEach((ch) => this.chLane.set(ch, i)));
    this.invalidate();
  }

  setDoc(doc, { keepView = false } = {}) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.sel.clear();
    if (!keepView) this.scrollBeat = -0.5;
    this._timing = null;
    this.invalidate();
  }

  // ---- geometry ----

  get t() {
    if (!this._timing) this._timing = timing(this.doc);
    return this._timing;
  }

  shownMeasures() { return measureCount(this.doc) + EXTRA_MEASURES; }

  _size() {
    const r = this.canvas.getBoundingClientRect();
    return { W: r.width, H: r.height };
  }

  // Left edge of the lanes: centred, with room for the measure gutter.
  get x0() {
    const { W } = this._size();
    let w = 0;
    for (const l of this.lanes) w += l.w * LANE_PX;
    return Math.max(GUTTER, Math.round((W - w - BGM_W - 6) / 2));
  }

  laneX(i) {
    let x = this.x0;
    for (let k = 0; k < i; k++) x += this.lanes[k].w * LANE_PX;
    return x;
  }

  lanesRight() { return this.laneX(this.lanes.length); }

  laneAt(x) {
    for (let i = 0; i < this.lanes.length; i++) {
      const a = this.laneX(i), b = a + this.lanes[i].w * LANE_PX;
      if (x >= a && x < b) return i;
    }
    return -1;
  }

  yOf(beat) { return this._size().H - FOOT - (beat - this.scrollBeat) * this.ppb; }
  beatAt(y) { return this.scrollBeat + (this._size().H - FOOT - y) / this.ppb; }

  beatOf(e) { return this.t.beatOf(e.m, e.pos); }

  // The note type a click in lane i places.
  laneCh(i) {
    const id = this.lanes[i].id;
    const types = LANE_TYPES[id];
    return types ? types[this.alt[id] ? 1 : 0] : this.lanes[i].channels[0];
  }

  // The drum note under a point, if any.
  noteAt(x, y) {
    const i = this.laneAt(x);
    if (i < 0) return null;
    const chs = this.lanes[i].channels;
    let best = null, dist = 7;
    for (const e of this.doc.events) {
      if (!chs.includes(e.ch)) continue;
      const d = Math.abs(this.yOf(this.beatOf(e)) - y);
      if (d < dist) { dist = d; best = e; }
    }
    return best;
  }

  selected() { return this.doc.events.filter((e) => this.sel.has(keyOf(e))); }

  // ---- edits ----

  // Apply a change: new document plus the events to select afterwards.
  commit(doc, select = null) {
    if (!doc || doc === this.doc) return false;
    this.undoStack.push({ doc: this.doc, sel: [...this.sel] });
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
    this.redoStack = [];
    this.doc = doc;
    this._timing = null;
    this.dirty = true;
    if (select) this.sel = new Set(select.map(keyOf));
    else this.sel = new Set([...this.sel].filter((k) => doc.events.some((e) => keyOf(e) === k)));
    this.invalidate();
    this.onChange?.(this);
    return true;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push({ doc: this.doc, sel: [...this.sel] });
    this._restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push({ doc: this.doc, sel: [...this.sel] });
    this._restore(s);
  }

  _restore(s) {
    this.doc = s.doc;
    this.sel = new Set(s.sel);
    this._timing = null;
    this.dirty = true;
    this.invalidate();
    this.onChange?.(this);
  }

  markSaved() { this.dirty = false; this.onChange?.(this); }

  // Sound for a new note: the one used most on that type, then in the lane,
  // then the last one used, then the most common drum sound.
  valFor(ch) {
    const lane = this.chLane.get(ch);
    return commonWav(this.doc, ch)
      || this.lanes[lane]?.channels.map((c) => commonWav(this.doc, c)).find(Boolean)
      || this.lastVal
      || DRUM_CHANNELS.map((c) => commonWav(this.doc, c)).find(Boolean)
      || '01';
  }

  placeAt(lane, beat) {
    let doc = this.doc;
    const shown = this.shownMeasures();
    const at = positionAt(doc, beat, this.grid, shown);
    if (!at) return;
    if (at.m >= measureCount(doc)) doc = extend(doc, at.m + 1);
    const ch = this.laneCh(lane);
    const ev = { m: at.m, ch, pos: at.pos, val: this.valFor(ch) };
    // The lane's other type at the same spot is replaced.
    const clash = doc.events.filter((e) => this.lanes[lane].channels.includes(e.ch) && e.m === ev.m
      && e.pos.n * ev.pos.d === ev.pos.n * e.pos.d);
    doc = addEvents(removeEvents(doc, clash), [ev]);
    this.lastVal = ev.val;
    this.cursorBeat = this.t.beatOf(at.m, at.pos);
    this.commit(doc, [ev]);
  }

  deleteSelection() {
    const list = this.selected();
    if (list.length) this.commit(removeEvents(this.doc, list), []);
  }

  // Move the selection by beats and lanes (keeps note types where it can).
  moveSelection(beats, lanes = 0) {
    const list = this.selected();
    if (!list.length) return false;
    const mapCh = (ch) => {
      const from = this.chLane.get(ch);
      const to = from + lanes;
      if (lanes === 0) return ch;
      const target = this.lanes[to];
      const types = LANE_TYPES[target.id];
      const isAlt = Object.values(LANE_TYPES).some((t) => t[1] === ch);
      return types ? types[isAlt ? 1 : 0] : target.channels[0];
    };
    for (const e of list) {
      const to = this.chLane.get(e.ch) + lanes;
      if (to < 0 || to >= this.lanes.length) return false;
    }
    let doc = this.doc;
    const end = Math.max(...list.map((e) => this.beatOf(e))) + beats;
    const starts = measureStarts(doc, this.shownMeasures());
    let need = 0;
    while (need < this.shownMeasures() && starts[need + 1] <= end + 1e-9) need++;
    if (need >= measureCount(doc)) doc = extend(doc, need + 1);
    const moved = shiftEvents(doc, list, beats, { mapCh, grid: FINE });
    if (!moved) return false;
    const t2 = timing(moved);
    const after = moved.events.filter((e) => [...list].some((o) =>
      Math.abs(t2.beatOf(e.m, e.pos) - (this.beatOf(o) + beats)) < 1e-6 && e.ch === mapCh(o.ch) && e.val === o.val));
    return this.commit(moved, after);
  }

  copy() {
    const list = this.selected();
    if (!list.length) return 0;
    const base = Math.min(...list.map((e) => this.beatOf(e)));
    this._clip = list.map((e) => ({ dBeat: this.beatOf(e) - base, ch: e.ch, val: e.val }));
    return list.length;
  }

  paste() {
    if (!this._clip?.length) return;
    let doc = this.doc;
    const base = this.playBeat ?? this.cursorBeat;
    const last = base + Math.max(...this._clip.map((c) => c.dBeat));
    const starts = measureStarts(doc, measureCount(doc) + 1000);
    let need = 0;
    while (starts[need + 1] <= last + 1e-9) need++;
    if (need >= measureCount(doc)) doc = extend(doc, need + 1);
    const list = [];
    for (const c of this._clip) {
      const at = positionAt(doc, base + c.dBeat, FINE);
      if (at) list.push({ m: at.m, ch: c.ch, pos: at.pos, val: c.val });
    }
    this.commit(addEvents(doc, list), list);
  }

  selectAll() {
    this.sel = new Set(this.doc.events.filter((e) => this.chLane.has(e.ch)).map(keyOf));
    this.invalidate();
  }

  setGrid(g) { this.grid = g; this.invalidate(); }

  setTool(t) {
    this.tool = t;
    this._drag = null;
    this.invalidate();
  }

  zoom(f, aroundY = null) {
    const { H } = this._size();
    const y = aroundY ?? (H - FOOT) / 2;
    const b = this.beatAt(y);
    this.ppb = Math.max(8, Math.min(400, this.ppb * f));
    this.scrollBeat = b - (H - FOOT - y) / this.ppb;
    this._clampScroll();
    this.invalidate();
  }

  _clampScroll() {
    const total = measureStarts(this.doc, this.shownMeasures())[this.shownMeasures()];
    this.scrollBeat = Math.max(-1, Math.min(total - 1, this.scrollBeat));
  }

  // Keep a beat in view (playback follows the playhead).
  reveal(beat) {
    const { H } = this._size();
    const top = this.beatAt(0), bottom = this.scrollBeat;
    const span = (H - FOOT) / this.ppb;
    if (beat < bottom + span * 0.1 || beat > top - span * 0.25) {
      this.scrollBeat = beat - span * 0.25;
      this._clampScroll();
    }
    this.invalidate();
  }

  // Keyboard; returns true when handled.
  key(e) {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (mod && (k === 'z' || k === 'Z')) { e.shiftKey ? this.redo() : this.undo(); return true; }
    if (mod && (k === 'y' || k === 'Y')) { this.redo(); return true; }
    if (mod && (k === 'c' || k === 'C')) { this.copy(); return true; }
    if (mod && (k === 'x' || k === 'X')) { if (this.copy()) this.deleteSelection(); return true; }
    if (mod && (k === 'v' || k === 'V')) { this.paste(); return true; }
    if (mod && (k === 'a' || k === 'A')) { this.selectAll(); return true; }
    if (mod) return false;
    if (k === 'Delete' || k === 'Backspace') { this.deleteSelection(); return true; }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      this.moveSelection((k === 'ArrowUp' ? 1 : -1) * (4 / this.grid));
      return true;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') { this.moveSelection(0, k === 'ArrowLeft' ? -1 : 1); return true; }
    if (k === 'Escape' && this.sel.size) { this.sel.clear(); this.invalidate(); return true; }
    if (k === '+' || k === '=') { this.zoom(1.25); return true; }
    if (k === '-' || k === '_') { this.zoom(0.8); return true; }
    if (k === 'p' || k === 'P' || k === 'b' || k === 'B') { this.setTool('pen'); this.onChange?.(this); return true; }
    if (k === 'v' || k === 'V' || k === 's' || k === 'S') { this.setTool('select'); this.onChange?.(this); return true; }
    if (k === 'o' || k === 'O') { this.alt.HH = !this.alt.HH; this.invalidate(); this.onChange?.(this); return true; }
    if (k === 'l' || k === 'L') { this.alt.LP = !this.alt.LP; this.invalidate(); this.onChange?.(this); return true; }
    return false;
  }

  // ---- pointer ----

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _down(e) {
    if (!this.doc) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const p = this._local(e);
    this._pointers.set(e.pointerId, p);
    if (this._pointers.size === 2) {
      // Two fingers: scroll + pinch.
      const [a, b] = [...this._pointers.values()];
      this._drag = { mode: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), midY: (a.y + b.y) / 2, ppb: this.ppb, scroll: this.scrollBeat };
      return;
    }
    if (this._pointers.size > 2) return;
    const { H } = this._size();
    if (p.y > H - FOOT) {
      const i = this.laneAt(p.x);
      const id = this.lanes[i]?.id;
      if (LANE_TYPES[id]) { this.alt[id] = !this.alt[id]; this.invalidate(); this.onChange?.(this); }
      this._drag = null;
      return;
    }
    if (p.x < this.x0) {
      this._drag = { mode: 'gutter', y0: p.y, scroll: this.scrollBeat, moved: false };
      return;
    }
    const lane = this.laneAt(p.x);
    if (lane < 0) { this._drag = { mode: 'rect', x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: e.shiftKey }; return; }
    const hit = this.noteAt(p.x, p.y);
    if (this.tool === 'pen') {
      if (hit) {
        this.cursorBeat = this.beatOf(hit);
        this.commit(removeEvents(this.doc, [hit]));
      } else {
        this.placeAt(lane, this.beatAt(p.y));
      }
      this._drag = null;
      return;
    }
    // Select tool.
    if (hit) {
      const k = keyOf(hit);
      if (e.shiftKey) {
        if (this.sel.has(k)) this.sel.delete(k); else this.sel.add(k);
      } else if (!this.sel.has(k)) {
        this.sel = new Set([k]);
      }
      this.cursorBeat = this.beatOf(hit);
      this._drag = { mode: 'move', y0: p.y, x0: p.x, lane0: lane, dBeat: 0, dLane: 0 };
      this.invalidate();
      return;
    }
    this._drag = { mode: 'rect', x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: e.shiftKey };
    const at = positionAt(this.doc, this.beatAt(p.y), this.grid, this.shownMeasures());
    if (at) this.cursorBeat = this.t.beatOf(at.m, at.pos);
  }

  _move(e) {
    if (!this.doc) return;
    const p = this._local(e);
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, p);
    const d = this._drag;
    if (!d) {
      this._hover = this.tool === 'pen' && this.laneAt(p.x) >= 0 && p.y < this._size().H - FOOT ? p : null;
      this._status(p);
      this.invalidate();
      return;
    }
    if (d.mode === 'pinch' && this._pointers.size >= 2) {
      const [a, b] = [...this._pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const midY = (a.y + b.y) / 2;
      this.ppb = Math.max(8, Math.min(400, d.ppb * dist / Math.max(1, d.dist)));
      const { H } = this._size();
      const anchor = d.scroll + (H - FOOT - d.midY) / d.ppb;
      this.scrollBeat = anchor - (H - FOOT - midY) / this.ppb;
      this._clampScroll();
    } else if (d.mode === 'gutter') {
      if (Math.abs(p.y - d.y0) > 4) d.moved = true;
      this.scrollBeat = d.scroll + (p.y - d.y0) / this.ppb;
      this._clampScroll();
    } else if (d.mode === 'rect') {
      d.x1 = p.x; d.y1 = p.y;
    } else if (d.mode === 'move') {
      const step = 4 / this.grid;
      d.dBeat = Math.round(((d.y0 - p.y) / this.ppb) / step) * step;
      const lane = this.laneAt(p.x);
      d.dLane = lane >= 0 ? lane - d.lane0 : d.dLane;
    }
    this._status(p);
    this.invalidate();
  }

  _up(e, cancel = false) {
    this._pointers.delete(e.pointerId);
    const d = this._drag;
    if (!d) return;
    if (d.mode === 'pinch') { if (!this._pointers.size) this._drag = null; return; }
    this._drag = null;
    if (cancel) { this.invalidate(); return; }
    if (d.mode === 'gutter' && !d.moved) {
      const beat = Math.max(0, this.beatAt(d.y0));
      this.cursorBeat = beat;
      this.onSeek?.(this.t.timeOfBeat(beat), beat);
    } else if (d.mode === 'rect') {
      const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
      const [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
      if (!d.add) this.sel.clear();
      if (x1 - x0 > 3 || y1 - y0 > 3) {
        for (const ev of this.doc.events) {
          const lane = this.chLane.get(ev.ch);
          if (lane === undefined) continue;
          const cx = this.laneX(lane) + this.lanes[lane].w * LANE_PX / 2;
          const y = this.yOf(this.beatOf(ev));
          if (cx >= x0 && cx <= x1 && y >= y0 && y <= y1) this.sel.add(keyOf(ev));
        }
      }
    } else if (d.mode === 'move' && (d.dBeat || d.dLane)) {
      this.moveSelection(d.dBeat, d.dLane);
    }
    this.invalidate();
    this.onChange?.(this);
  }

  _wheel(e) {
    if (!this.doc) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.zoom(Math.exp(-e.deltaY * 0.002), this._local(e).y);
      return;
    }
    this.scrollBeat -= e.deltaY / this.ppb;
    this._clampScroll();
    this.invalidate();
  }

  _status(p) {
    if (!this.onStatus) return;
    const at = positionAt(this.doc, this.beatAt(p.y), this.grid, this.shownMeasures());
    if (!at || p.x < this.x0) { this.onStatus(''); return; }
    const steps = Math.round(this.grid * lenOf(this.doc, at.m));
    const k = Math.round(fracValue(at.pos) * steps);
    const bpm = this.t.bpmAt(this.t.beatOf(at.m, at.pos));
    this.onStatus(`Measure ${String(at.m).padStart(3, '0')} · ${k + 1}/${steps} · BPM ${Math.round(bpm * 100) / 100}`);
  }

  // ---- drawing ----

  invalidate() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.render(); });
  }

  render() {
    const cv = this.canvas, g = this.g;
    const { W, H } = this._size();
    if (!W || !H || !this.doc) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#101018';
    g.fillRect(0, 0, W, H);

    const shown = this.shownMeasures();
    const real = measureCount(this.doc);
    const starts = measureStarts(this.doc, shown);
    const x0 = this.x0, x1 = this.lanesRight();
    const bgmX = x1 + 6;
    const bottom = H - FOOT;
    const vis0 = this.beatAt(bottom), vis1 = this.beatAt(0);

    g.save();
    g.beginPath();
    g.rect(0, 0, W, bottom);
    g.clip();

    // Lanes.
    this.lanes.forEach((l, i) => {
      g.fillStyle = i % 2 ? '#181826' : '#1c1c2c';
      g.fillRect(this.laneX(i), 0, l.w * LANE_PX, bottom);
    });
    g.fillStyle = '#151520';
    g.fillRect(bgmX, 0, BGM_W, bottom);

    // Measures, grid, beats.
    g.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    for (let m = 0; m < shown; m++) {
      const b0 = starts[m], b1 = starts[m + 1];
      if (b1 < vis0 || b0 > vis1) continue;
      const len = lenOf(this.doc, m);
      if (m >= real) {
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(x0, this.yOf(b1), x1 - x0, this.yOf(b0) - this.yOf(b1));
      }
      const steps = Math.max(1, Math.round(this.grid * len));
      if ((b1 - b0) * this.ppb / steps >= 5) {
        g.fillStyle = 'rgba(255,255,255,0.06)';
        for (let k = 1; k < steps; k++) g.fillRect(x0, Math.round(this.yOf(b0 + (b1 - b0) * k / steps)), x1 - x0, 1);
      }
      g.fillStyle = 'rgba(255,255,255,0.16)';
      for (let q = 1; q < len * 4 - 1e-9; q++) g.fillRect(x0, Math.round(this.yOf(b0 + q)), x1 - x0, 1);
      const y = Math.round(this.yOf(b0));
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.fillRect(x0 - 8, y, x1 - x0 + 8 + BGM_W + 6, 1);
      g.fillStyle = m < real ? '#e8e8f0' : '#666680';
      g.textAlign = 'right';
      g.fillText(String(m).padStart(3, '0'), x0 - 12, y - 3);
      if (Math.abs(len - 1) > 1e-9) {
        const q = len * 4;
        const sig = Number.isInteger(q) ? `${q}/4` : Number.isInteger(q * 2) ? `${q * 2}/8` : `×${Math.round(len * 1000) / 1000}`;
        g.fillStyle = '#ffd24d';
        g.fillText(sig, x0 - 12, y - 15);
      }
    }

    // Tempo changes.
    g.textAlign = 'left';
    for (const e of this.doc.events) {
      if (e.ch !== 0x03 && e.ch !== 0x08) continue;
      const b = this.beatOf(e);
      if (b < vis0 - 1 || b > vis1 + 1) continue;
      const y = Math.round(this.yOf(b));
      g.fillStyle = '#ff9030';
      g.fillRect(x0 - GUTTER + 4, y, GUTTER - 10, 1);
      g.fillText(`${Math.round(this.t.bpmAt(b + 1e-9) * 100) / 100}`, x0 - GUTTER + 4, y - 3);
    }

    // BGM / sound effects column.
    for (const e of this.doc.events) {
      if (e.ch !== 0x01 && !(e.ch >= 0x61 && e.ch <= 0x92)) continue;
      const b = this.beatOf(e);
      if (b < vis0 - 1 || b > vis1 + 1) continue;
      g.fillStyle = e.ch === 0x01 ? '#8a8aa6' : '#5a5a76';
      g.fillRect(bgmX + 3, this.yOf(b) - 3, BGM_W - 6, 6);
    }

    // Notes.
    const d = this._drag;
    const moving = d?.mode === 'move' ? d : null;
    for (const e of this.doc.events) {
      const lane = this.chLane.get(e.ch);
      if (lane === undefined) continue;
      const isSel = this.sel.has(keyOf(e));
      let b = this.beatOf(e);
      let li = lane;
      if (isSel && moving) { b += moving.dBeat; li = Math.max(0, Math.min(this.lanes.length - 1, lane + moving.dLane)); }
      if (b < vis0 - 1 || b > vis1 + 1) continue;
      this._note(g, li, b, e.ch, isSel);
    }

    // Pen ghost.
    if (this._hover && this.tool === 'pen' && !d) {
      const lane = this.laneAt(this._hover.x);
      const at = positionAt(this.doc, this.beatAt(this._hover.y), this.grid, shown);
      if (lane >= 0 && at && !this.noteAt(this._hover.x, this._hover.y)) {
        g.globalAlpha = 0.35;
        this._note(g, lane, this.t.beatOf(at.m, at.pos), this.laneCh(lane), false);
        g.globalAlpha = 1;
      }
    }

    // Selection rectangle.
    if (d?.mode === 'rect') {
      g.strokeStyle = 'rgba(77,163,255,0.9)';
      g.fillStyle = 'rgba(77,163,255,0.12)';
      const rx = Math.min(d.x0, d.x1), ry = Math.min(d.y0, d.y1);
      g.fillRect(rx, ry, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.strokeRect(rx + 0.5, ry + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }

    // Playhead.
    if (this.playBeat != null) {
      const y = Math.round(this.yOf(this.playBeat));
      g.fillStyle = '#ff4d4d';
      g.fillRect(x0 - GUTTER, y - 1, bgmX + BGM_W - (x0 - GUTTER), 2);
    }
    g.restore();

    // Lane labels (tap HH / LP to switch the note type placed).
    g.fillStyle = '#1a1a26';
    g.fillRect(0, bottom, W, FOOT);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, bottom, W, 1);
    g.textAlign = 'center';
    g.font = '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    this.lanes.forEach((l, i) => {
      const ch = this.laneCh(i);
      const name = TYPE_NAME[ch] || l.id;
      g.fillStyle = this.colors[CH_TYPE.get(ch)] || '#ccc';
      g.fillText(LANE_TYPES[l.id] ? `${name} ⇄` : name, this.laneX(i) + l.w * LANE_PX / 2, bottom + 18);
    });
    g.fillStyle = '#8a8aa6';
    g.fillText('BGM', bgmX + BGM_W / 2, bottom + 18);
  }

  _note(g, lane, beat, ch, selected) {
    const l = this.lanes[lane];
    const x = this.laneX(lane) + 3;
    const w = l.w * LANE_PX - 6;
    const y = Math.round(this.yOf(beat));
    const color = this.colors[CH_TYPE.get(ch)] || '#ccc';
    if (ch === 0x18) {
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.strokeRect(x + 1, y - NOTE_H / 2 + 1, w - 2, NOTE_H - 2);
    } else {
      g.fillStyle = color;
      g.fillRect(x, y - NOTE_H / 2, w, NOTE_H);
      if (ch === 0x1C) { // left bass drum: marked so it reads apart from LP
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(x + w / 2 - 1, y - NOTE_H / 2, 2, NOTE_H);
      }
    }
    if (selected) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      g.strokeRect(x - 2, y - NOTE_H / 2 - 2, w + 4, NOTE_H + 4);
    }
  }

  destroy() {
    this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}
