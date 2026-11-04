// Static full-chart viewer (DTXCharter / dtxviewertool style).
//
// Renders an entire parsed DTX chart as a static image: measures are laid out
// as vertical strips read bottom-to-top, columns read left-to-right, with
// colored note chips on drum lanes. Unlike the live highway in player.js this
// does not scroll and is decoupled from the audio/RAF clock — it draws the
// whole chart at once, either into an on-screen <canvas> or a detached one for
// PNG export. Lane resolution, colors and chip conventions are shared with the
// highway via buildLanes / CH_TYPE / defaultColors from player.js.

import { buildLanes, CH_TYPE, defaultColors } from './player.js';

const DEFAULTS = {
  pxPerBeat: 32,          // vertical scale
  columnHeightPx: 1000,   // target strip height; taller = fewer, wider-safe columns
  laneWidthPx: 16,        // px per lane width-unit (scaled by LANE_DEF[].w)
  gutterPx: 42,           // left gutter per column (measure # + BPM marker)
  colGapPx: 22,           // gap between columns
  marginPx: 24,           // outer margin
  labelBandPx: 22,        // lane-label row at the top of each column
  noteH: 5,               // chip height in px
  background: '#000',
  showBarLines: true,
  showBeatLines: true,
  showMeasureNumbers: true,
  showBpm: true,
  showLaneLabels: true,
  maxCanvasPx: 8192,      // clamp device-pixel dimensions (browser canvas cap)
};

function lower(arr, t, key) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][key] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Find the measure containing time t (measures sorted by tStart). Returns index
// or -1. Uses tEnd so trailing time past the last measure returns -1.
function measureAt(measures, t) {
  let lo = 0, hi = measures.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < measures[mid].tStart) hi = mid - 1;
    else if (t >= measures[mid].tEnd) lo = mid + 1;
    else { res = mid; break; }
  }
  return res;
}

// Pure geometry. Returns a layout object consumed by drawChartView.
export function layoutChart(dtx, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const colors = o.colors || defaultColors();
  const { lanes, chToLane } = buildLanes({
    laneOrder: o.laneOrder,
    groups: o.groups,
    hiddenLanes: o.hiddenLanes,
  });

  // Lane x-offsets within a column's lane area (same width model as the highway).
  const laneOffset = [];
  const laneWidth = [];
  let lx = 0;
  for (const lane of lanes) {
    laneOffset.push(lx);
    const w = (lane.w ?? 1) * o.laneWidthPx;
    laneWidth.push(w);
    lx += w;
  }
  const laneArea = lx || o.laneWidthPx;

  // BPM at a given time (initial #BPM + subsequent changes).
  const bpmChanges = dtx.bpmChanges || [];
  const bpmAt = (t) => {
    let bpm = dtx.bpm > 0 ? dtx.bpm : 120;
    for (const c of bpmChanges) {
      if (c.time <= t + 1e-6) bpm = c.bpm; else break;
    }
    return bpm;
  };

  // Build measures from bars, up to and including the one holding the last chip.
  const bars = dtx.bars;
  const chartEnd = dtx.chartEnd || 0;
  let lastIdx = 0;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].time <= chartEnd + 1e-6) lastIdx = i;
  }
  const measures = [];
  let prevBpm = null;
  for (let i = 0; i <= lastIdx && i < bars.length; i++) {
    const tStart = bars[i].time;
    const beats = bars[i].beats > 0 ? bars[i].beats : 4;
    let tEnd = bars[i + 1] ? bars[i + 1].time : null;
    if (tEnd == null) {
      const spb = measures.length ? measures[measures.length - 1].secPerBeat : 60 / (dtx.bpm || 120);
      tEnd = tStart + beats * spb;
    }
    const bpm = bpmAt(tStart);
    measures.push({
      num: bars[i].num, beats, tStart, tEnd,
      secPerBeat: (tEnd - tStart) / beats,
      heightPx: beats * o.pxPerBeat,
      bpm, bpmChanged: prevBpm === null || Math.abs(bpm - prevBpm) > 1e-6,
      colIndex: 0, yTop: 0, yBottom: 0,
    });
    prevBpm = bpm;
  }

  // Greedy-pack whole measures into columns not exceeding columnHeightPx.
  const columns = [];
  let cur = null;
  for (const m of measures) {
    if (!cur || (cur.height + m.heightPx > o.columnHeightPx && cur.measures.length)) {
      cur = { measures: [], height: 0, xLeft: 0 };
      columns.push(cur);
      m.colIndex = columns.length - 1;
    } else {
      m.colIndex = columns.length - 1;
    }
    cur.measures.push(m);
    cur.height += m.heightPx;
  }
  const maxColHeight = columns.reduce((a, c) => Math.max(a, c.height), 0);

  // Vertical: bottom-align every column to a shared baseline; stack upward.
  const contentTop = o.marginPx + o.labelBandPx;
  const contentBottom = contentTop + maxColHeight;
  for (const c of columns) {
    let yBottom = contentBottom;
    for (const m of c.measures) {
      m.yBottom = yBottom;
      m.yTop = yBottom - m.heightPx;
      yBottom = m.yTop;
    }
  }

  // Horizontal: gutter + lane area + gap per column.
  const colStride = o.gutterPx + laneArea + o.colGapPx;
  columns.forEach((c, i) => { c.xLeft = o.marginPx + i * colStride; });

  const width = o.marginPx * 2 + Math.max(1, columns.length) * colStride - o.colGapPx;
  const height = contentBottom + o.marginPx;

  return {
    opts: o, colors, lanes, chToLane, laneOffset, laneWidth, laneArea,
    columns, measures, contentTop, contentBottom, width, height,
    chips: dtx.chips || [], beats: dtx.beats || [],
  };
}

// Draw a computed layout into a 2D context already transformed to css units.
export function drawChartView(ctx, layout) {
  const o = layout.opts;
  const g = ctx;
  const { colors, lanes, chToLane, laneOffset, laneWidth, laneArea, columns } = layout;

  g.fillStyle = o.background;
  g.fillRect(0, 0, layout.width, layout.height);

  // Lane bands + separators, per column.
  for (const c of columns) {
    const areaX = c.xLeft + o.gutterPx;
    const top = layout.contentBottom - c.height;
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < lanes.length; i++) {
      g.fillRect(areaX + laneOffset[i] + 1, top, laneWidth[i] - 2, c.height);
    }
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 1;
    g.beginPath();
    let x = areaX;
    for (let i = 0; i <= lanes.length; i++) {
      g.moveTo(Math.round(x) + 0.5, top);
      g.lineTo(Math.round(x) + 0.5, layout.contentBottom);
      if (i < lanes.length) x += laneWidth[i];
    }
    g.stroke();

    // Lane labels in the top band.
    if (o.showLaneLabels) {
      g.font = 'bold 11px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      const ly = o.marginPx + o.labelBandPx - 7;
      for (let i = 0; i < lanes.length; i++) {
        g.fillStyle = colors[lanes[i].id] || '#ccc';
        g.fillText(lanes[i].id, areaX + laneOffset[i] + laneWidth[i] / 2, ly);
      }
    }
  }

  const areaXof = (m) => columns[m.colIndex].xLeft + o.gutterPx;
  const yOf = (m, t) => m.yBottom - ((t - m.tStart) / (m.tEnd - m.tStart)) * m.heightPx;

  // Beat lines (dim).
  if (o.showBeatLines) {
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 1;
    g.beginPath();
    for (const b of layout.beats) {
      const mi = measureAt(layout.measures, b.time);
      if (mi < 0) continue;
      const m = layout.measures[mi];
      const y = Math.round(yOf(m, b.time)) + 0.5;
      const ax = areaXof(m);
      g.moveTo(ax, y);
      g.lineTo(ax + laneArea, y);
    }
    g.stroke();
  }

  // Bar lines + measure numbers + BPM markers.
  g.font = '11px sans-serif';
  g.textBaseline = 'alphabetic';
  for (const m of layout.measures) {
    const ax = areaXof(m);
    if (o.showBarLines) {
      g.strokeStyle = 'rgba(255,255,255,0.32)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(ax, Math.round(m.yBottom) + 0.5);
      g.lineTo(ax + laneArea, Math.round(m.yBottom) + 0.5);
      // Close the top of a column's topmost measure.
      if (columns[m.colIndex].measures[columns[m.colIndex].measures.length - 1] === m) {
        g.moveTo(ax, Math.round(m.yTop) + 0.5);
        g.lineTo(ax + laneArea, Math.round(m.yTop) + 0.5);
      }
      g.stroke();
    }
    if (o.showMeasureNumbers) {
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.textAlign = 'right';
      g.fillText(String(m.num).padStart(3, '0'), ax - 6, m.yBottom - 3);
    }
    if (o.showBpm && m.bpmChanged) {
      g.fillStyle = 'rgba(120,200,255,0.85)';
      g.textAlign = 'right';
      g.font = '10px sans-serif';
      g.fillText('♩' + Math.round(m.bpm * 100) / 100, ax - 6, m.yBottom - 15);
      g.font = '11px sans-serif';
    }
  }

  // Note chips.
  const noteH = o.noteH;
  for (const chip of layout.chips) {
    if (!chip.visible) continue;
    const laneIdx = chToLane.get(chip.ch);
    if (laneIdx === undefined) continue;
    const mi = measureAt(layout.measures, chip.time);
    if (mi < 0) continue;
    const m = layout.measures[mi];
    const lane = lanes[laneIdx];
    const y = yOf(m, chip.time);
    const ax = areaXof(m);
    const foreign = !lane.channels.includes(chip.ch);
    const inset = foreign ? Math.round(laneWidth[laneIdx] * 0.12) : 0;
    const cx = ax + laneOffset[laneIdx] + 2 + inset;
    const cw = laneWidth[laneIdx] - 4 - inset * 2;
    const color = colors[CH_TYPE.get(chip.ch)] || colors[lane.id] || '#fff';
    // Notes are bottom-aligned to their timing: the chip's bottom edge sits on
    // the bar/beat line for that time, growing upward.
    if (chip.ch === 0x18) {
      // Open hi-hat: hollow.
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.strokeRect(cx + 0.5, y - noteH + 0.5, cw - 1, noteH - 1);
    } else {
      g.fillStyle = color;
      g.fillRect(cx, y - noteH, cw, noteH);
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.fillRect(cx, y - noteH, cw, 1);
    }
  }
}

// Size a canvas (with dpr clamping) and render the chart. Returns the layout.
export function renderChartView(canvas, dtx, opts = {}) {
  const layout = layoutChart(dtx, opts);
  const cssW = layout.width, cssH = layout.height;
  const maxSide = layout.opts.maxCanvasPx;
  const dprBase = opts.dpr ?? (globalThis.devicePixelRatio || 1);
  // Single css->device scale; shrinks below 1 for oversized charts.
  const k = Math.min(dprBase, maxSide / cssW, maxSide / cssH);
  canvas.width = Math.max(1, Math.round(cssW * k));
  canvas.height = Math.max(1, Math.round(cssH * k));
  // On-screen: display at css size so the wrapper scrolls naturally.
  if (opts.setStyleSize !== false) {
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawChartView(ctx, layout);
  return layout;
}

// Render to a detached canvas and resolve a PNG Blob.
export async function exportChartPng(dtx, opts = {}) {
  const canvas = document.createElement('canvas');
  renderChartView(canvas, dtx, { ...opts, setStyleSize: false });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Chart image is too large to export.');
  return blob;
}
