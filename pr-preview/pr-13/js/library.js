// DTXMania-style library tree: scanning imported folders into boxes and
// songs, box.def / set.def parsing, path helpers and search normalisation.
// Pure (no DOM, no IndexedDB), so it runs under `node --test`.
//
// Folder rules, as DTXManiaNX's CSongManager enumerates songs:
// - A folder whose name starts with "DTXFiles." is a BOX (title = the rest),
//   and so is any folder containing box.def (box.def's #TITLE wins).
// - set.def lists the folder's songs (one per #TITLE block, #L1–#L5FILE).
// - Without set.def, the folder's charts are songs. Unlike DTXMania, which
//   lists every .dtx on its own, all charts in one folder form one song with
//   several difficulties: they share the folder's sounds, so splitting them
//   would store the same files several times.
// - Any other folder is flattened into its parent's list.

import { parseDTX } from './dtx.js';

// ---- paths ----

// Normalize an archive path: backslashes to slashes, resolve ./ and ../,
// lowercase (DTX files come from case-insensitive filesystems).
export function normPath(p) {
  const parts = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/').toLowerCase();
}

// Same, keeping the original case (for export names).
function cleanPath(p) {
  const parts = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export function dirname(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function stripExt(p) {
  const i = p.lastIndexOf('.');
  return i < 0 ? p : p.slice(0, i);
}

const join = (a, b) => (a && b ? `${a}/${b}` : a || b);

// Resolve a WAV reference relative to the chart's directory, with fallbacks:
// alternate audio extensions (DTXMania does this too — charts often say .wav
// or .xa while the package ships .ogg, or vice versa), then (unless
// anywhere is false) a basename search through every file.
export const AUDIO_EXTS = ['.ogg', '.wav', '.mp3', '.m4a', '.flac', '.aac', '.opus', '.webm', '.xa'];

export function makeResolver(fileMap, baseDir, { anywhere = true } = {}) {
  return (ref) => {
    const rel = normPath(ref);
    const p = baseDir ? normPath(baseDir + '/' + ref.replace(/\\/g, '/')) : rel;
    for (const cand of [p, rel]) {
      if (fileMap.has(cand)) return fileMap.get(cand);
      const stem = stripExt(cand);
      for (const ext of AUDIO_EXTS) {
        if (fileMap.has(stem + ext)) return fileMap.get(stem + ext);
      }
    }
    if (!anywhere) return null;
    const wantBase = stripExt(basename(p));
    for (const [k, v] of fileMap) {
      const kb = basename(k);
      if (stripExt(kb) === wantBase && AUDIO_EXTS.includes(kb.slice(stripExt(kb).length))) return v;
    }
    return null;
  };
}

export function isJunkPath(path) {
  return path.includes('__MACOSX/') || basename(path).startsWith('._') || basename(path) === '.DS_Store';
}

// ---- box.def / set.def ----

// box.def keys as CBoxDef.cs reads them: a line starting with '#', ';' starts
// a comment, keys match by prefix (case-insensitive) and the value is the
// rest with ':', spaces and tabs trimmed off both ends.
const BOX_KEYS = [
  ['TITLE', 'title'], ['ARTIST', 'artist'], ['COMMENT', 'comment'], ['GENRE', 'genre'],
  ['PREVIEW', 'preview'], ['PREIMAGE', 'preimage'], ['PREMOVIE', 'premovie'],
  ['SKINPATH', 'skinpath'], ['FONTCOLOR', 'color'],
];

const trimDef = (s) => s.replace(/^[:\s]+|[:\s]+$/g, '');

function defLines(text) {
  const out = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    let line = raw.replace(/^[ \t]+/, '');
    if (!line.startsWith('#')) continue;
    const sc = line.indexOf(';');
    if (sc >= 0) line = line.slice(0, sc);
    out.push(line.slice(1));
  }
  return out;
}

export function parseBoxDef(text) {
  const def = { title: '', artist: '', comment: '', genre: '', color: '' };
  for (const line of defLines(text)) {
    const up = line.toUpperCase();
    for (const [key, field] of BOX_KEYS) {
      if (up.startsWith(key)) { def[field] = trimDef(line.slice(key.length)); break; }
    }
  }
  return def;
}

// Write box.def text: the stored raw def with our edited fields replaced (or
// appended), so keys we don't model (hit ranges, skins, …) survive.
export function writeBoxDef(raw, fields) {
  const keys = { title: 'TITLE', genre: 'GENRE', color: 'FONTCOLOR', comment: 'COMMENT', artist: 'ARTIST' };
  const lines = (raw || '').split(/\r\n|\n|\r/);
  const done = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^[ \t]*#([A-Za-z]+)/);
    if (!m) return line;
    const up = m[1].toUpperCase();
    for (const [field, key] of Object.entries(keys)) {
      if (up === key && fields[field] !== undefined && !done.has(field)) {
        done.add(field);
        return fields[field] ? `#${key}: ${fields[field]}` : null;
      }
    }
    return line;
  }).filter((l) => l !== null);
  while (out.length && !out[out.length - 1].trim()) out.pop();
  for (const [field, key] of Object.entries(keys)) {
    if (!done.has(field) && fields[field]) out.push(`#${key}: ${fields[field]}`);
  }
  return out.join('\r\n') + '\r\n';
}

// set.def as CSetDef.cs reads it: each #TITLE starts a new song once the
// current block is in use; up to five #LnLABEL / #LnFILE pairs per song.
// Returns [{ title, genre, color, charts: [{ label, file }] }].
export function parseSetDefSongs(text) {
  const songs = [];
  let cur = null;
  const used = (b) => b && (b.title || b.genre || b.color || b.slots.size);
  const fresh = () => ({ title: '', genre: '', color: '', slots: new Map() });
  for (const line of defLines(text)) {
    const m = line.match(/^([A-Za-z0-9]+)[ \t]*:?[ \t]*(.*)$/);
    if (!m) continue;
    const cmd = m[1].toUpperCase();
    const val = m[2].trim();
    let lm;
    if (cmd === 'TITLE') {
      if (used(cur)) songs.push(cur);
      if (!cur || used(cur)) cur = fresh();
      cur.title = val;
      continue;
    }
    cur ||= fresh();
    if (cmd === 'GENRE') cur.genre = val;
    else if (cmd === 'FONTCOLOR') cur.color = val && !val.startsWith('#') ? '#' + val : val;
    else if ((lm = cmd.match(/^L([1-5])LABEL$/))) {
      const s = cur.slots.get(lm[1]) || {};
      s.label = val;
      cur.slots.set(lm[1], s);
    } else if ((lm = cmd.match(/^L([1-5])FILE$/))) {
      const s = cur.slots.get(lm[1]) || {};
      s.file = val;
      cur.slots.set(lm[1], s);
    }
  }
  if (used(cur)) songs.push(cur);
  return songs.map((b) => ({
    title: b.title, genre: b.genre, color: b.color,
    charts: [...b.slots.entries()].sort((x, y) => x[0] - y[0])
      .filter(([, s]) => s.file).map(([, s]) => ({ label: s.label || '', file: s.file })),
  })).filter((b) => b.charts.length);
}

// ---- tree scan ----

const isChart = (n) => n.endsWith('.dtx');

// entries: [{ path (archive/folder-relative, original case), blob }]
// readText(blob) -> Promise<string> (Shift-JIS aware in the app).
// Returns {
//   boxes: [{ key, parentKey, title, genre, color, comment, artist, folder, def }]
//     (key = normalized folder path; parentKey null = the import root)
//   songs: [{ boxKey, folder, title, artist, genre, dtxs, files }]
//     folder: the song folder relative to its box folder (original case)
//     files: [{ path, origPath, blob }], relative to the box folder
//     dtxs: [{ path, title, label, level, bpm }] sorted by level
// }
export async function scanTree(entries, readText) {
  const byNorm = new Map(); // norm path -> { orig, blob }
  for (const e of entries) {
    const orig = cleanPath(e.path);
    if (!orig || isJunkPath(orig)) continue;
    byNorm.set(normPath(orig), { orig, blob: e.blob });
  }

  // Folder index: norm dir -> { orig, files: [norm], dirs: [norm] }
  const dirs = new Map([['', { orig: '', files: [], dirs: [] }]]);
  const ensureDir = (n, orig) => {
    if (dirs.has(n)) return;
    const parent = dirname(n);
    ensureDir(parent, dirname(orig));
    dirs.set(n, { orig, files: [], dirs: [] });
    dirs.get(parent).dirs.push(n);
  };
  for (const [n, f] of byNorm) {
    const d = dirname(n);
    ensureDir(d, dirname(f.orig));
    dirs.get(d).files.push(n);
  }

  const hasFile = (d, name) => dirs.get(d).files.includes(join(d, name));
  const isBox = (d) => d !== '' && (basename(d).startsWith('dtxfiles.') || hasFile(d, 'box.def'));
  const isSongDir = (d) => hasFile(d, 'set.def') || dirs.get(d).files.some(isChart);
  const fileMap = new Map([...byNorm].map(([n, f]) => [n, n]));

  const boxes = [];
  const songs = [];

  // Files of a song folder: its own plus those in plain sub-folders that
  // hold no songs or boxes of their own.
  const songFiles = (d, out = new Set()) => {
    for (const n of dirs.get(d).files) out.add(n);
    for (const sub of dirs.get(d).dirs) {
      if (!isBox(sub) && !isSongDir(sub)) songFiles(sub, out);
    }
    return out;
  };

  const readChart = async (n) => {
    let h = { title: '', artist: '', genre: '', level: null, bpm: null, wavs: new Map(), preview: null, preimage: null };
    try { h = parseDTX(await readText(byNorm.get(n).blob), { headersOnly: true }); } catch { /* keep defaults */ }
    return h;
  };

  // Add every file a chart refers to (sounds, preview) that the folder scan
  // missed, e.g. shared sounds reached with ../. No basename guessing here:
  // that could pull in another song's same-named file.
  const addRefs = (chartNorm, h, set) => {
    const resolve = makeResolver(fileMap, dirname(chartNorm), { anywhere: false });
    const refs = [...h.wavs.values()].map((w) => w.file);
    if (h.preview) refs.push(h.preview);
    if (h.preimage) refs.push(h.preimage);
    for (const r of refs) {
      if (!r) continue;
      const hit = resolve(r);
      if (hit) set.add(hit);
    }
  };

  const relTo = (base, n) => (!base ? n : n.startsWith(base + '/') ? n.slice(base.length + 1) : `_shared/${n}`);

  const makeSong = async (d, boxKey, block, chartNorms, fileSet) => {
    const dtxs = [];
    let artist = '';
    for (const n of chartNorms) {
      const h = await readChart(n);
      addRefs(n, h, fileSet);
      artist ||= h.artist || '';
      dtxs.push({
        norm: n,
        title: h.title || basename(byNorm.get(n).orig),
        label: '',
        level: h.level,
        bpm: h.bpm,
        genre: h.genre || '',
      });
    }
    if (block) {
      for (const c of block.charts) {
        const n = normPath(join(d, c.file));
        const m = dtxs.find((x) => x.norm === n);
        if (m) m.label = c.label;
      }
    }
    dtxs.sort((a, b) => (a.level ?? 999) - (b.level ?? 999));
    const base = boxKey || '';
    const dirOrig = dirs.get(d).orig;
    const boxOrig = boxKey ? dirs.get(boxKey).orig : '';
    songs.push({
      boxKey,
      folder: boxOrig ? (dirOrig.startsWith(boxOrig + '/') ? dirOrig.slice(boxOrig.length + 1) : '') : dirOrig,
      title: block?.title || dtxs[0]?.title || basename(dirOrig),
      artist,
      genre: block?.genre || dtxs.find((x) => x.genre)?.genre || '',
      dtxs: dtxs.map(({ norm, title, label, level, bpm }) => ({ path: relTo(base, norm), title, label, level, bpm })),
      files: [...fileSet].sort().map((n) => ({
        path: relTo(base, n),
        origPath: relTo(base.length ? dirs.get(boxKey).orig : '', byNorm.get(n).orig),
        blob: byNorm.get(n).blob,
      })),
    });
  };

  const songsIn = async (d, boxKey) => {
    const setDef = hasFile(d, 'set.def') ? join(d, 'set.def') : null;
    if (setDef) {
      let blocks = [];
      try { blocks = parseSetDefSongs(await readText(byNorm.get(setDef).blob)); } catch { /* fall back */ }
      blocks = blocks.map((b) => ({
        ...b, charts: b.charts.filter((c) => byNorm.has(normPath(join(d, c.file)))),
      })).filter((b) => b.charts.length);
      if (blocks.length === 1) {
        const charts = blocks[0].charts.map((c) => normPath(join(d, c.file)));
        await makeSong(d, boxKey, blocks[0], charts, songFiles(d));
        return;
      }
      if (blocks.length > 1) {
        // Several songs share the folder: each keeps only its charts, the
        // files they refer to, and set.def.
        for (const b of blocks) {
          const charts = b.charts.map((c) => normPath(join(d, c.file)));
          await makeSong(d, boxKey, b, charts, new Set([...charts, setDef]));
        }
        return;
      }
    }
    const charts = dirs.get(d).files.filter(isChart).sort();
    if (charts.length) await makeSong(d, boxKey, null, charts, songFiles(d));
  };

  const walk = async (d, boxKey) => {
    if (isBox(d)) {
      const name = basename(dirs.get(d).orig);
      const prefix = /^dtxfiles\./i.test(name) ? name.slice(9) : '';
      let def = { title: '', artist: '', comment: '', genre: '', color: '' };
      let raw = '';
      if (hasFile(d, 'box.def')) {
        try {
          raw = await readText(byNorm.get(join(d, 'box.def')).blob);
          def = parseBoxDef(raw);
        } catch { /* unreadable box.def: plain box */ }
      }
      boxes.push({
        key: d,
        parentKey: boxKey,
        title: def.title || prefix || name,
        genre: def.genre,
        color: def.color,
        comment: def.comment,
        artist: def.artist,
        folder: name,
        def: raw,
      });
      boxKey = d;
    }
    if (isSongDir(d)) await songsIn(d, boxKey);
    for (const sub of [...dirs.get(d).dirs].sort()) await walk(sub, boxKey);
  };

  await walk('', null);
  return { boxes, songs };
}

// ---- search ----

// NFKC (full/half width), lowercase, katakana -> hiragana.
export function normalizeForSearch(s) {
  return (s || '').normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function searchTerms(query) {
  return normalizeForSearch(query).split(/\s+/).filter(Boolean);
}

// Every term must occur somewhere in the haystack.
export function matchTerms(haystack, terms) {
  for (const t of terms) if (!haystack.includes(t)) return false;
  return true;
}

// The normalised text a song is found by: title, artist, chart titles and
// labels, its folder, and the title/genre of every box above it.
export function songHaystack(song, boxPath = []) {
  const bits = [song.title, song.artist, song.genre, song.folder];
  for (const d of song.dtxs || []) bits.push(d.title, d.label);
  for (const b of boxPath) bits.push(b.title, b.genre);
  return normalizeForSearch(bits.filter(Boolean).join('\n'));
}

// ---- box tree helpers ----

// [root … box] ancestry of a box id (empty for the root).
export function boxPathOf(boxes, id) {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const out = [];
  const seen = new Set();
  for (let b = byId.get(id); b && !seen.has(b.id); b = byId.get(b.parent)) {
    seen.add(b.id);
    out.unshift(b);
  }
  return out;
}

// Ids of a box and every box below it.
export function descendantIds(boxes, id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of boxes) {
      if (b.parent != null && out.has(b.parent) && !out.has(b.id)) { out.add(b.id); grew = true; }
    }
  }
  return out;
}

// ---- sort ----

const levelOf = (s) => {
  const l = (s.dtxs || []).map((d) => d.level).filter((x) => Number.isFinite(x));
  return l.length ? Math.max(...l) : -1;
};
const bpmOf = (s) => {
  const b = (s.dtxs || []).map((d) => d.bpm).filter((x) => Number.isFinite(x) && x > 0);
  return b.length ? b[0] : -1;
};
const coll = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export const SORTS = {
  title: (a, b) => coll.compare(a.title || '', b.title || ''),
  artist: (a, b) => coll.compare(a.artist || '', b.artist || '') || coll.compare(a.title || '', b.title || ''),
  level: (a, b) => levelOf(b) - levelOf(a) || coll.compare(a.title || '', b.title || ''),
  bpm: (a, b) => bpmOf(a) - bpmOf(b) || coll.compare(a.title || '', b.title || ''),
  added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
};

// Filters: { levelMin, levelMax, bpmMin, bpmMax, kind: '' | 'dtx' | 'gp' | 'rec' | 'stems' }
export function passesFilters(song, f) {
  if (!f) return true;
  const levels = (song.dtxs || []).map((d) => d.level).filter((x) => Number.isFinite(x));
  if (f.levelMin != null || f.levelMax != null) {
    const lo = f.levelMin ?? -Infinity, hi = f.levelMax ?? Infinity;
    if (!levels.some((l) => normLevel(l) >= lo && normLevel(l) <= hi)) return false;
  }
  if (f.bpmMin != null || f.bpmMax != null) {
    const lo = f.bpmMin ?? -Infinity, hi = f.bpmMax ?? Infinity;
    const bpms = (song.dtxs || []).map((d) => d.bpm).filter((x) => Number.isFinite(x) && x > 0);
    if (!bpms.some((b) => b >= lo && b <= hi)) return false;
  }
  const gp = song.source === 'guitarpro';
  if (f.kind === 'dtx' && gp) return false;
  if (f.kind === 'gp' && !gp) return false;
  if (f.kind === 'rec' && !song.sync?.audio) return false;
  if (f.kind === 'stems' && !song.sync?.stems) return false;
  return true;
}

// DTX levels are written either 1–100 (#DLEVEL 65) or 1.00–9.99; compare on
// the 0–10 scale the cards show.
export function normLevel(l) {
  return l > 10 ? l / 10 : l;
}

// ---- Shift-JIS ----

// DTXMania reads box.def and set.def as Shift-JIS. Browsers can decode it but
// not encode it, so the encoder is built once by decoding every code.
let sjisMap = null;
function buildSjisMap() {
  const dec = new TextDecoder('shift_jis');
  const map = new Map();
  for (let b = 0xA1; b <= 0xDF; b++) map.set(dec.decode(new Uint8Array([b])), [b]); // half-width kana
  const leads = [];
  for (let b = 0x81; b <= 0x9F; b++) leads.push(b);
  for (let b = 0xE0; b <= 0xFC; b++) leads.push(b);
  for (const lead of leads) {
    for (let trail = 0x40; trail <= 0xFC; trail++) {
      if (trail === 0x7F) continue;
      const ch = dec.decode(new Uint8Array([lead, trail]));
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [lead, trail]);
    }
  }
  return map;
}

// Text -> Shift-JIS bytes; characters it can't hold become '?'.
export function encodeShiftJIS(text) {
  sjisMap ||= buildSjisMap();
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else out.push(...(sjisMap.get(ch) || [0x3F]));
  }
  return new Uint8Array(out);
}
