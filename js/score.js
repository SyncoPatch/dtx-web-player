// Engraves a parsed DTX chart as black-on-white drum sheet music (A4 PDF).
//
// Print-grade formatting beyond the live tab strip: no beat lines, notes
// padded off the barlines, flams rendered as grace notes, tuplet numbers on
// beams, basic rests, and density-aware measure packing.

import { PDFDoc } from './pdf.js';
import { TAB_HANDS, TAB_FEET, TAB_XHEAD } from './player.js';

const EPS = 1e-4;
// Subdivisions tried per beat, binary first so straight rhythms never get
// tuplet markings by accident.
const DIVISIONS = [1, 2, 4, 8, 3, 6, 5, 7];
const DIV_BEAMS = { 1: 0, 2: 1, 4: 2, 8: 3, 3: 1, 6: 2, 5: 2, 7: 3 };
const TUPLET = { 3: '3', 6: '6', 5: '5', 7: '7' };

// ---------- musical model ----------

// Exported for tests. Returns measures with per-beat quantization, beams,
// flams (grace notes), tuplets and rest plans.
export function buildScoreModel({ chips, bars, beats }) {
  const bounds = [...bars.map((b) => b.time), ...beats.map((b) => b.time)]
    .sort((a, b) => a - b);
  const beatDurAt = (t) => {
    let lo = 0, hi = bounds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bounds[mid] <= t + 1e-9) lo = mid + 1;
      else hi = mid;
    }
    const i = lo - 1;
    if (i >= 0 && i + 1 < bounds.length) return bounds[i + 1] - bounds[i];
    return bounds.length > 1 ? bounds[bounds.length - 1] - bounds[bounds.length - 2] : 0.5;
  };

  const notes = chips.filter((c) => c.visible && (TAB_HANDS.has(c.ch) || TAB_FEET.has(c.ch)));

  // Flams: two hits on the same drum far closer together than the finest
  // normal grid (under beat/12, capped at 80ms) — the first becomes a grace
  // note of the second.
  const byCh = new Map();
  for (const c of notes) {
    if (!byCh.has(c.ch)) byCh.set(c.ch, []);
    byCh.get(c.ch).push(c);
  }
  const graceOf = new Map(); // grace chip -> main chip
  for (const arr of byCh.values()) {
    for (let i = 1; i < arr.length; i++) {
      const dt = arr[i].time - arr[i - 1].time;
      const D = beatDurAt(arr[i].time);
      if (dt > EPS && dt <= Math.min(0.08, D / 12) && !graceOf.has(arr[i - 1])) {
        graceOf.set(arr[i - 1], arr[i]);
      }
    }
  }

  // Columns of simultaneous main notes.
  const cols = [];
  let cur = null;
  for (const c of notes) {
    if (graceOf.has(c)) continue;
    if (!cur || c.time - cur.time > EPS) {
      cur = { time: c.time, hands: [], feet: [], graces: [] };
      cols.push(cur);
    }
    const hp = TAB_HANDS.get(c.ch);
    if (hp !== undefined) cur.hands.push({ ch: c.ch, p: hp });
    else cur.feet.push({ ch: c.ch, p: TAB_FEET.get(c.ch) });
  }
  const colAt = (t) => {
    let lo = 0, hi = cols.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cols[mid].time < t - EPS) lo = mid + 1;
      else hi = mid;
    }
    return lo < cols.length && Math.abs(cols[lo].time - t) <= EPS ? cols[lo] : null;
  };
  for (const [g, main] of graceOf) {
    const col = colAt(main.time);
    if (col) {
      col.graces.push({ ch: g.ch, p: TAB_HANDS.get(g.ch) ?? TAB_FEET.get(g.ch) });
    }
  }

  // Measures with their beat spans.
  const measures = [];
  let ci = 0;
  for (let m = 0; m < bars.length; m++) {
    const start = bars[m].time;
    const end = bars[m + 1]?.time ?? start + beatDurAt(start) * 4;
    if (end - start < EPS) continue;
    const spans = [];
    let prev = start;
    for (const b of bounds) {
      if (b > start + EPS && b < end - EPS) {
        if (b - prev > EPS) spans.push({ t0: prev, t1: b, cols: [] });
        prev = b;
      }
    }
    spans.push({ t0: prev, t1: end, cols: [] });
    const mcols = [];
    while (ci < cols.length && cols[ci].time < end - EPS) {
      if (cols[ci].time >= start - EPS) mcols.push(cols[ci]);
      ci++;
    }
    for (const col of mcols) {
      const s = spans.find((sp) => col.time >= sp.t0 - EPS && col.time < sp.t1 - EPS)
        || spans[spans.length - 1];
      s.cols.push(col);
    }
    measures.push({ num: bars[m].num, start, end, spans, cols: mcols });
  }

  // Quantize each beat; derive beams, flags, tuplets, rests.
  for (const meas of measures) {
    for (const beat of meas.spans) {
      const D = beat.t1 - beat.t0;
      const tol = D / 32 + 1e-6;
      beat.div = 8;
      beat.tuplet = null;
      beat.free = true;
      for (const div of DIVISIONS) {
        const slots = beat.cols.map((c) => Math.round((c.time - beat.t0) / (D / div)));
        const fits = beat.cols.every((c, i) =>
          slots[i] >= 0 && slots[i] < div &&
          Math.abs(c.time - beat.t0 - slots[i] * (D / div)) <= tol);
        const distinct = new Set(slots).size === slots.length;
        if (fits && distinct) {
          beat.div = div;
          beat.free = false;
          beat.tuplet = TUPLET[div] || null;
          beat.cols.forEach((c, i) => { c.grid = slots[i]; });
          break;
        }
      }
      if (beat.free) {
        beat.cols.forEach((c) => {
          c.grid = Math.max(0, Math.min(7, Math.round((c.time - beat.t0) / (D / 8))));
        });
      }

      // Beams / flags per voice.
      const nBeams = DIV_BEAMS[beat.div];
      beat.groups = [];
      beat.flagCols = [];
      for (const voice of ['hands', 'feet']) {
        const vcols = beat.cols.filter((c) => c[voice].length);
        if (vcols.length >= 2 && nBeams > 0) {
          const pairBeams = [];
          for (let i = 1; i < vcols.length; i++) {
            const gap = Math.max(1, vcols[i].grid - vcols[i - 1].grid);
            pairBeams.push(Math.max(1, nBeams - Math.floor(Math.log2(gap))));
          }
          beat.groups.push({ voice, cols: vcols, pairBeams });
        } else if (vcols.length === 1 && nBeams > 0 && vcols[0].grid > 0) {
          beat.flagCols.push({ voice, col: vcols[0], flags: nBeams });
        }
      }

      // Basic rests: empty beat -> quarter rest; leading binary gap -> 8th /
      // 16th rest(s). Internal/trailing gaps carry no rest.
      beat.rests = [];
      if (!beat.cols.length) {
        beat.rests.push({ type: 4, frac: 0 });
      } else if (!beat.tuplet && !beat.free) {
        const fr = Math.min(...beat.cols.map((c) => c.grid)) / beat.div;
        if (fr >= 0.5 - 1e-9) {
          beat.rests.push({ type: 8, frac: 0 });
          if (fr - 0.5 >= 0.25 - 1e-9) beat.rests.push({ type: 16, frac: 0.5 });
        } else if (fr >= 0.25 - 1e-9) {
          beat.rests.push({ type: 16, frac: 0 });
        }
      }
    }
    meas.wholeRest = meas.cols.length === 0;
    if (meas.wholeRest) for (const s of meas.spans) s.rests = [];

    // Meter (quarters): full spans + partial last span, kept as n/4 or n/8.
    const spanDur = meas.spans[0].t1 - meas.spans[0].t0;
    const L = meas.spans.reduce((a, s) => a + (s.t1 - s.t0), 0) / spanDur;
    const q = Math.round(L * 4) / 4;
    if (Math.abs(q - Math.round(q)) < 1e-9) meas.meter = [Math.round(q), 4];
    else if (Math.abs(q * 2 - Math.round(q * 2)) < 1e-9) meas.meter = [Math.round(q * 2), 8];
    else meas.meter = null;
  }

  return { measures };
}

// ---------- engraving ----------

const PAGE_W = 595, PAGE_H = 842, MARGIN = 40; // A4 portrait, points
const G = 7;                 // staff line gap
const SYS_ABOVE = 34;        // room above the staff (ledgers, beams, numbers)
const SYS_BELOW = 44;        // room below (feet stems/beams, pedal)
const SYS_ADVANCE = SYS_ABOVE + 4 * G + SYS_BELOW;
const STEM = 22;
const HEAD_RX = 3.4, HEAD_RY = 2.5;

function measureWidthWeight(meas) {
  return Math.max(55, 22 + 10.5 * meas.cols.length + (meas.wholeRest ? 20 : 0));
}

export async function buildScorePdf(data, opts = {}) {
  const model = buildScoreModel(data);
  const doc = new PDFDoc(PAGE_W, PAGE_H);
  const contentW = PAGE_W - 2 * MARGIN;

  // Pack measures into systems by density.
  const systems = [];
  {
    let sys = null;
    for (const meas of model.measures) {
      const w = measureWidthWeight(meas);
      if (!sys || (sys.weight + w > contentW - 22 && sys.items.length)) {
        sys = { items: [], weight: 0 };
        systems.push(sys);
      }
      sys.items.push({ meas, w });
      sys.weight += w;
    }
  }
  // Justify each system to the full line (cap stretch on the last one).
  for (let i = 0; i < systems.length; i++) {
    const sys = systems[i];
    const avail = contentW - 22; // clef zone
    let scale = avail / sys.weight;
    if (i === systems.length - 1) scale = Math.min(scale, 1.25);
    for (const it of sys.items) it.w *= scale;
  }

  const hasNonAscii = (s) => /[^\x20-\x7e]/.test(s);
  const drawText = (page, x, y, str, o = {}) => {
    if (str && hasNonAscii(str) && opts.textToImage) {
      const img = opts.textToImage(str, o.size || 10, o.font === 'B');
      if (img) {
        let ix = x;
        if (o.align === 'center') ix = x - img.pxWidth / 2;
        else if (o.align === 'right') ix = x - img.pxWidth;
        page.image(ix, y - (o.size || 10) * 0.94, img.pxWidth, img.pxHeight, img);
        return;
      }
    }
    if (o.gray) page.setFill(o.gray);
    page.text(x, y, str, o);
    if (o.gray) page.setFill(0);
  };

  let page = doc.addPage();
  let pageNo = 1;
  let y = MARGIN + 14;

  // Header on page 1.
  if (data.title) {
    drawText(page, PAGE_W / 2, y + 12, data.title, { size: 20, font: 'B', align: 'center' });
    y += 26;
    const sub = [data.artist, data.bpm && `BPM ${data.bpm}`, data.level != null && `Lv ${data.level}`]
      .filter(Boolean).join('    -    ');
    if (sub) {
      drawText(page, PAGE_W / 2, y + 6, sub, { size: 10, align: 'center', gray: 0.35 });
      y += 16;
    }
    y += 10;
  }

  let prevMeter = null;
  for (const sys of systems) {
    if (y + SYS_ADVANCE > PAGE_H - MARGIN - 10) {
      page = doc.addPage();
      pageNo++;
      y = MARGIN + 6;
    }
    const staffTop = y + SYS_ABOVE;
    const yOfP = (p) => staffTop + (p * G) / 2;

    // Staff lines.
    page.setStroke(0);
    page.setLineWidth(0.7);
    for (let i = 0; i < 5; i++) {
      page.line(MARGIN, yOfP(i * 2), PAGE_W - MARGIN, yOfP(i * 2));
    }
    // Percussion clef.
    page.rect(MARGIN + 4, yOfP(2), 2.3, 2 * G, true);
    page.rect(MARGIN + 9.5, yOfP(2), 2.3, 2 * G, true);
    // System-start measure number.
    drawText(page, MARGIN, staffTop - 10, String(sys.items[0].meas.num).padStart(3, '0'),
      { size: 7, gray: 0.45 });

    let mx = MARGIN + 22;
    for (const it of sys.items) {
      const meas = it.meas;
      const mw = it.w;
      page.setLineWidth(0.8);
      page.line(mx, yOfP(0), mx, yOfP(8)); // left barline

      let lead = 12;
      // Time signature on meter change.
      if (meas.meter && (!prevMeter || meas.meter[0] !== prevMeter[0] || meas.meter[1] !== prevMeter[1])) {
        page.text(mx + 8, yOfP(2) + 4.5, String(meas.meter[0]), { size: 13, font: 'B', align: 'center' });
        page.text(mx + 8, yOfP(6) + 4.5, String(meas.meter[1]), { size: 13, font: 'B', align: 'center' });
        lead += 14;
      }
      if (meas.meter) prevMeter = meas.meter;

      const span = mw - lead - 7;
      const n = meas.spans.length;
      const xOfBeat = (bi, frac) => mx + lead + ((bi + frac) / n) * span;

      if (meas.wholeRest) {
        page.rect(mx + lead + span / 2 - 5, yOfP(2), 10, 3, true);
      }

      meas.spans.forEach((beat, bi) => {
        const xOfCol = (c) => xOfBeat(bi, beat.free
          ? (c.time - beat.t0) / (beat.t1 - beat.t0)
          : c.grid / beat.div);

        // Note heads, graces, ledgers.
        for (const c of beat.cols) {
          const x = xOfCol(c);
          c._x = x;
          for (const list of [c.hands, c.feet]) {
            for (const nte of list) {
              drawHead(page, x, yOfP(nte.p), nte.ch);
              if (nte.p <= -2) {
                page.setLineWidth(0.7);
                for (let lp = -2; lp >= nte.p; lp -= 2) {
                  page.line(x - 5.4, yOfP(lp), x + 5.4, yOfP(lp));
                }
              }
            }
          }
          for (const gr of c.graces) drawGrace(page, x, yOfP, gr);
        }

        // Stems, beams, flags.
        for (const grp of beat.groups) {
          drawBeamGroup(page, grp, yOfP);
          if (beat.tuplet) drawTuplet(page, grp, beat.tuplet, yOfP);
        }
        for (const f of beat.flagCols) drawFlagged(page, f, yOfP);
        // Lone quarter-position notes: plain stems.
        for (const voice of ['hands', 'feet']) {
          const vcols = beat.cols.filter((c) => c[voice].length);
          if (vcols.length === 1 && !beat.flagCols.some((f) => f.col === vcols[0] && f.voice === voice)
              && !beat.groups.some((g) => g.voice === voice)) {
            drawStem(page, vcols[0], voice, yOfP);
          }
        }

        // Rests.
        for (const r of beat.rests) drawRest(page, xOfBeat(bi, r.frac), r.type, yOfP);
      });

      mx += mw;
    }
    page.setLineWidth(0.8);
    page.line(mx, yOfP(0), mx, yOfP(8)); // system-end barline
    if (sys === systems[systems.length - 1]) {
      page.rect(mx - 4.4, yOfP(0), 3, 4 * G, true); // final thick bar
    }
    y += SYS_ADVANCE;
  }

  // Page footers.
  const total = doc.pages.length;
  if (total > 1) {
    doc.pages.forEach((p, i) => {
      p.text(PAGE_W / 2, PAGE_H - 22, `${i + 1} / ${total}`, { size: 9, align: 'center' });
    });
  }

  return doc.finish();
}

// ---------- glyphs ----------

function drawHead(page, x, y, ch) {
  if (TAB_XHEAD.has(ch)) {
    page.setLineWidth(1.3);
    page.line(x - 3, y - 3, x + 3, y + 3);
    page.line(x - 3, y + 3, x + 3, y - 3);
    if (ch === 0x18) { // open hi-hat ring
      page.setLineWidth(0.8);
      page.ellipse(x, y - 7.5, 1.8, 1.8, false);
    }
  } else {
    page.ellipse(x, y, HEAD_RX, HEAD_RY, true);
  }
}

function stemAnchor(col, voice, yOfP) {
  const ps = col[voice].map((n) => n.p);
  if (voice === 'hands') {
    return { x: col._x + 3.2, from: yOfP(Math.max(...ps)), top: yOfP(Math.min(...ps)) };
  }
  return { x: col._x - 3.2, from: yOfP(Math.min(...ps)), top: yOfP(Math.max(...ps)) };
}

function drawStem(page, col, voice, yOfP) {
  const a = stemAnchor(col, voice, yOfP);
  const dir = voice === 'hands' ? -1 : 1;
  page.setLineWidth(1);
  page.line(a.x, a.from, a.x, a.top + dir * STEM);
  return a.top + dir * STEM;
}

function drawBeamGroup(page, grp, yOfP) {
  const up = grp.voice === 'hands';
  const dir = up ? -1 : 1;
  let extreme = up ? Infinity : -Infinity;
  for (const c of grp.cols) {
    for (const n of c[grp.voice]) {
      const yy = yOfP(n.p);
      extreme = up ? Math.min(extreme, yy) : Math.max(extreme, yy);
    }
  }
  const yBeam = extreme + dir * STEM;
  page.setLineWidth(1);
  const xs = [];
  for (const c of grp.cols) {
    const a = stemAnchor(c, grp.voice, yOfP);
    xs.push(a.x);
    page.line(a.x, a.from, a.x, yBeam);
  }
  const bh = 2.2, step = 3.4;
  for (let level = 1; level <= 3; level++) {
    // Secondary beams stack toward the noteheads.
    const yl = yBeam - dir * (level - 1) * step - (up ? 0 : bh);
    if (level === 1) {
      page.rect(xs[0] - 0.5, yl, xs[xs.length - 1] - xs[0] + 1, bh, true);
    } else {
      for (let i = 0; i < grp.pairBeams.length; i++) {
        if (grp.pairBeams[i] >= level) {
          page.rect(xs[i] - 0.5, yl, xs[i + 1] - xs[i] + 1, bh, true);
        }
      }
    }
  }
  grp._yBeam = yBeam;
  grp._xs = xs;
}

function drawTuplet(page, grp, label, yOfP) {
  const up = grp.voice === 'hands';
  const midX = (grp._xs[0] + grp._xs[grp._xs.length - 1]) / 2;
  const y = grp._yBeam + (up ? -4 : 12);
  page.text(midX, y, label, { size: 8, font: 'I', align: 'center' });
}

function drawFlagged(page, f, yOfP) {
  const up = f.voice === 'hands';
  const dir = up ? -1 : 1;
  const tip = drawStem(page, f.col, f.voice, yOfP);
  const a = stemAnchor(f.col, f.voice, yOfP);
  page.setLineWidth(1);
  for (let i = 0; i < f.flags; i++) {
    const y0 = tip - dir * i * 4;
    page.path([
      ['M', a.x, y0],
      ['C', a.x + 5, y0 + dir * 3, a.x + 6.5, y0 + dir * 7, a.x + 3.5, y0 + dir * 11],
    ], { stroke: true });
  }
}

function drawGrace(page, x, yOfP, gr) {
  const gx = x - 7.5;
  const gy = yOfP(gr.p);
  page.ellipse(gx, gy, 2, 1.5, true);
  page.setLineWidth(0.7);
  page.line(gx + 1.9, gy, gx + 1.9, gy - 10);          // mini stem
  page.line(gx - 0.5, gy - 7.5, gx + 4.3, gy - 4.5);   // slash
  // Small slur arc to the main note.
  page.path([
    ['M', gx, gy + 3],
    ['C', gx + 2, gy + 5.6, x - 2, gy + 5.6, x, gy + 3],
  ], { stroke: true });
}

function drawRest(page, x, type, yOfP) {
  page.setLineWidth(1);
  if (type === 4) {
    // Stylized quarter rest zigzag.
    page.path([
      ['M', x - 1.5, yOfP(1.6)],
      ['L', x + 2.2, yOfP(2.9)],
      ['C', x - 1.2, yOfP(3.7), x + 2.6, yOfP(4.2), x + 1.4, yOfP(5.4)],
      ['C', x - 2.8, yOfP(4.6), x - 0.6, yOfP(3.9), x + 0.4, yOfP(3.6)],
      ['L', x - 1.5, yOfP(2.3)],
    ], { stroke: true });
  } else {
    // 8th/16th rest: dot(s) with a hook onto a slanted stem.
    const dots = type === 8 ? 1 : 2;
    for (let i = 0; i < dots; i++) {
      const dy = yOfP(2.6 + i * 1.4);
      page.ellipse(x - 1.6 + i * -0.7, dy, 1.2, 1.2, true);
      page.path([
        ['M', x - 0.6 + i * -0.7, dy + 0.8],
        ['C', x + 0.8, dy + 1.6, x + 1.6, dy + 1.2, x + 2.2 - i * 0.7, dy - 0.8],
      ], { stroke: true });
    }
    page.line(x + 2.2, yOfP(2.4), x + 2.2 - (dots - 1) * 0.7 - 1.4, yOfP(2.4 + dots * 1.6 + 1.2));
  }
}
