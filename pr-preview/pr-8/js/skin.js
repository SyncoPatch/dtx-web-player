// DTXMania (DTXManiaNX) skin support.
//
// An NX skin is a folder of images with hard-coded filenames under
// `<skin>/Graphics/`; there is no config file — every sprite coordinate lives
// in the DTXManiaNX C# source. The tables below are transcribed from
// CStagePerfDrumsScreen.cs, CActPerfDrumsLaneFlushD.cs and CActPerfDrumsPad.cs.
//
// Only the gameplay assets the player renders are stored (whitelist below);
// full skins ship song-select/result art we never use and can be tens of MB.
// Every accessor returns null when its image is missing, so partial skins
// degrade per-element to the procedural renderer (like CSkin.Path()'s
// fallback to the default skin).

import { getSkinFiles } from './db.js';

// 7_chips_drums.png note-chip columns, keyed by NOTE_TYPES key. Cells are
// 64px tall; the animated rows start at y=128, frames 0-7 at 70ms per frame
// (a single global counter drives all chips, as in NX).
export const CHIP_COLS = {
  BD:  { sx: 0,   sw: 70 },
  HH:  { sx: 70,  sw: 56 },
  SD:  { sx: 126, sw: 64 },
  HT:  { sx: 190, sw: 56 },
  LT:  { sx: 246, sw: 56 },
  FT:  { sx: 302, sw: 56 },
  CY:  { sx: 358, sw: 74 },
  RD:  { sx: 432, sw: 48 },
  LBD: { sx: 480, sw: 58 }, // NX "type B" LBD graphic (type A reuses LP)
  LC:  { sx: 538, sw: 74 },
  OH:  { sx: 612, sw: 48 },
  LP:  { sx: 660, sw: 58 },
};

// 7_Paret.png lane-panel columns (full-height 720px strips), keyed by lane id.
const PARET_COLS = {
  LC: { sx: 0,   sw: 72 },
  HH: { sx: 72,  sw: 49 },
  LP: { sx: 121, sw: 51 },
  SD: { sx: 172, sw: 57 },
  HT: { sx: 229, sw: 49 },
  BD: { sx: 278, sw: 69 },
  LT: { sx: 347, sw: 49 },
  FT: { sx: 396, sw: 54 },
  CY: { sx: 450, sw: 70 },
  RD: { sx: 520, sw: 38 },
};

// 7_pads.png / "ScreenPlayDrums pads flush.png" 96x96 cells, keyed by lane id.
const PAD_CELLS = {
  LC: [0, 0],    HH: [96, 0],   CY: [192, 0],  RD: [288, 0],
  SD: [0, 96],   HT: [96, 96],  LT: [192, 96], FT: [288, 96],
  BD: [0, 192],  LP: [96, 192],
};

// "ScreenPlayDrums lane flush <name>[ reverse].png", keyed by lane id.
const FLUSH_NAME = {
  LC: 'leftcymbal', HH: 'hihat', SD: 'snare', BD: 'bass', HT: 'hitom',
  LT: 'lowtom', FT: 'floortom', CY: 'cymbal', RD: 'ridecymbal', LP: 'leftpedal',
};

// "ScreenPlayDrums chip fire_<KEY>.png" lane keys; OH fires HH, LBD fires LP.
const FIRE_KEYS = ['LC', 'HH', 'SD', 'BD', 'HT', 'LT', 'FT', 'CY', 'LP', 'RD'];

const CHIP_SHEET = '7_chips_drums.png';

// Whitelist of skin files worth storing (lowercased basenames).
export const SKIN_FILES = new Set([
  CHIP_SHEET,
  '7_paret.png',
  '7_paret_dark.png',
  '7_background.jpg',
  '7_background.png',
  '7_pads.png',
  'screenplaydrums hit-bar.png',
  'screenplaydrums pads flush.png',
  ...FIRE_KEYS.map((k) => `screenplaydrums chip fire_${k.toLowerCase()}.png`),
  ...Object.values(FLUSH_NAME).flatMap((n) => [
    `screenplaydrums lane flush ${n}.png`,
    `screenplaydrums lane flush ${n} reverse.png`,
  ]),
  // The default skin ships both spellings; some skins only have the spaced one.
  'screenplaydrums lane flush left pedal.png',
  'screenplaydrums lane flush left pedal reverse.png',
]);

// Pick the gameplay files out of extracted archive entries
// ([{ name, data: Uint8Array }] from extractZip, or { name, blob }).
// The skin's Graphics dir may sit at any nesting depth; it's identified by
// containing 7_chips_drums.png. Returns [{ name, blob }] with lowercased
// basenames, ready for db.addSkin.
export function collectSkinFiles(entries) {
  const byDir = new Map(); // lowercased dir -> [{ base, entry }]
  for (const e of entries) {
    const path = e.name.replace(/\\/g, '/').toLowerCase();
    const cut = path.lastIndexOf('/');
    const dir = cut < 0 ? '' : path.slice(0, cut);
    const base = path.slice(cut + 1);
    if (!SKIN_FILES.has(base)) continue;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push({ base, entry: e });
  }
  // Shallowest dir that has the chip sheet wins; a dir with any whitelisted
  // file is accepted as a fallback (chips-less partial skins still count).
  const dirs = [...byDir.keys()].sort((a, b) => a.length - b.length);
  const dir = dirs.find((d) => byDir.get(d).some((f) => f.base === CHIP_SHEET)) ?? dirs[0];
  if (dir === undefined) {
    throw new Error('No DTXMania skin graphics found in this archive (expected a Graphics folder with 7_chips_drums.png).');
  }
  const files = [];
  const seen = new Set();
  for (const { base, entry } of byDir.get(dir)) {
    if (seen.has(base)) continue; // zip could hold duplicates; first wins
    seen.add(base);
    files.push({ name: base, blob: entry.blob ?? new Blob([entry.data]) });
  }
  return files;
}

export class Skin {
  constructor(images) {
    this.img = images; // Map<lowercased basename, ImageBitmap>
    const chips = images.get(CHIP_SHEET);
    // Animated rows live at y>=128; short sheets fall back to the static row.
    if (chips && chips.height >= 192) {
      this.chipBaseY = 128;
      this.chipFrames = Math.max(1, Math.min(8, Math.floor((chips.height - 128) / 64)));
    } else {
      this.chipBaseY = 0;
      this.chipFrames = 1;
    }
  }

  // Decode a stored skin into ImageBitmaps. Per-file decode failures just
  // drop that element (procedural fallback).
  static async load(skinId) {
    const files = await getSkinFiles(skinId);
    const images = new Map();
    await Promise.all(files.map(async (f) => {
      try {
        images.set(f.name, await createImageBitmap(f.blob));
      } catch (err) {
        console.warn(`skin: failed to decode ${f.name}`, err);
      }
    }));
    return new Skin(images);
  }

  _get(...names) {
    for (const n of names) {
      const bmp = this.img.get(n);
      if (bmp) return bmp;
    }
    return null;
  }

  get bg() { return this._get('7_background.jpg', '7_background.png'); }
  get hitBar() { return this._get('screenplaydrums hit-bar.png'); }

  // Global chip animation clock (NX: CCounter(0, 7, 70ms)).
  chipFrame(nowMs) { return Math.floor(nowMs / 70) % this.chipFrames; }

  // Source rect for a note chip, by NOTE_TYPES key.
  chipSprite(key, frame) {
    const bmp = this.img.get(CHIP_SHEET);
    const col = CHIP_COLS[key];
    if (!bmp || !col || col.sx + col.sw > bmp.width) return null;
    return { bmp, sx: col.sx, sy: this.chipBaseY + frame * 64, sw: col.sw, sh: 64 };
  }

  // Lane background panel column, by lane id.
  paret(laneId) {
    const bmp = this._get('7_paret.png');
    const col = PARET_COLS[laneId];
    if (!bmp || !col || col.sx + col.sw > bmp.width) return null;
    return { bmp, sx: col.sx, sw: col.sw };
  }

  // Whole-image lane hit flash, by lane id.
  flush(laneId, reverse) {
    const n = FLUSH_NAME[laneId];
    if (!n) return null;
    const suffix = reverse ? ' reverse' : '';
    const names = [`screenplaydrums lane flush ${n}${suffix}.png`];
    if (n === 'leftpedal') names.push(`screenplaydrums lane flush left pedal${suffix}.png`);
    if (reverse) names.push(...names.map((x) => x.replace(' reverse', ''))); // fall back to non-reverse art
    return this._get(...names);
  }

  // Hit explosion image, by note type key (OH -> HH, LBD -> LP, like NX).
  fire(key) {
    const k = key === 'OH' ? 'HH' : key === 'LBD' ? 'LP' : key;
    if (!FIRE_KEYS.includes(k)) return null;
    return this._get(`screenplaydrums chip fire_${k.toLowerCase()}.png`);
  }

  // Drum pad / lit pad 96x96 cell, by lane id.
  pad(laneId) { return this._padCell('7_pads.png', laneId); }
  padFlush(laneId) { return this._padCell('screenplaydrums pads flush.png', laneId); }

  _padCell(name, laneId) {
    const bmp = this._get(name);
    const cell = PAD_CELLS[laneId];
    if (!bmp || !cell || cell[0] + 96 > bmp.width || cell[1] + 96 > bmp.height) return null;
    return { bmp, sx: cell[0], sy: cell[1], s: 96 };
  }

  dispose() {
    for (const bmp of this.img.values()) bmp.close?.();
    this.img.clear();
  }
}
