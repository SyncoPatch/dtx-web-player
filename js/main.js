// App wiring: import (ZIP / folder), persisted song list, playback screen.

import { extractZip } from './zip.js';
import { createZip } from './zipwrite.js';
import { parseDTX, decodeText } from './dtx.js';
import {
  listSongs, addSong, patchSong, getSong, deleteSong, getSongFiles, listFileMeta,
  listSkins, addSkin, deleteSkin, getBoxes, updateBoxes,
} from './db.js';
import {
  normPath, dirname, basename, makeResolver, scanTree,
  searchTerms, matchTerms, songHaystack, boxPathOf, descendantIds, passesFilters, SORTS,
  writeBoxDef, encodeShiftJIS,
} from './library.js';
import { Player, NOTE_TYPES, LANE_IDS, GROUP_RULES, defaultColors, defaultDisplay } from './player.js';
import { Skin, collectSkinFiles } from './skin.js';
import { isGuitarProFile, convertGuitarPro } from './gp.js'; // alphaTab itself loads lazily
import { writeDtx } from './dtxwrite.js';
import { renderDrumKit, KIT_FILES } from './drumkit.js';
import { buildTimedChart, barTimesForSync } from './gpsync.js';
import { assignFeet, kickKey, pedalKey, DEFAULT_FEET, CH_BD, CH_LBD, CH_LP } from './feet.js';
import { SoundBank } from './audio.js';
import { ROLES, listModels, removeModel, installFromFiles, installFromUrl, opfsAvailable } from './models.js';

const $ = (id) => document.getElementById(id);

// crypto.randomUUID exists only in secure contexts (HTTPS, localhost); a LAN
// dev server (http://192.168.…) on iPad lacks it. getRandomValues works anywhere.
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const el = {
  screenSelect: $('screen-select'),
  screenPlayer: $('screen-player'),
  songList: $('song-list'),
  emptyHint: $('empty-hint'),
  fileZip: $('file-zip'),
  fileFolder: $('file-folder'),
  overlay: $('overlay'),
  overlayText: $('overlay-text'),
  npTitle: $('np-title'),
  npSub: $('np-sub'),
  npWarn: $('np-warn'),
  btnPlay: $('btn-play'),
  seek: $('seek'),
  timeCur: $('time-cur'),
  timeTotal: $('time-total'),
};

let player = null;
let seeking = false;
let currentDtx = null;   // parsed chart of the open song (for PDF export)
let currentMeta = null;  // { title, artist, bpm, level, label }
let current = null;      // { song, chartInfo, fileMap } of the open chart

// ---- persisted playback settings ----

const SETTINGS_KEY = 'dtx-settings';
const settings = {
  scroll: 1, playSpeed: 1, offsetMs: 0, tabPos: 'off', tabZoom: 1,
  volMaster: 0.9, volBgm: 1, volNotes: 1,
  groups: { lc: false, lp: false, ft: false, rd: false },
  laneOrder: [...LANE_IDS],
  colors: defaultColors(),
  display: defaultDisplay(),
  hiddenLanes: [],
  skinId: null,
  gpFeet: { kickSplit: true, hhClose: true }, // last choice in the GP import dialog
  keepVideos: false, // store BGA videos found in imports (they aren't played)
  libSort: 'title',  // library order: title | artist | level | bpm | added
};
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  Object.assign(settings, saved, {
    groups: { ...settings.groups, ...saved.groups },
    colors: { ...defaultColors(), ...saved.colors },
    display: { ...defaultDisplay(), ...saved.display },
    laneOrder: Array.isArray(saved.laneOrder) ? saved.laneOrder : settings.laneOrder,
    hiddenLanes: Array.isArray(saved.hiddenLanes) ? saved.hiddenLanes : [],
    // Migrate the old full-screen tab mode to the bottom strip.
    tabPos: saved.tabPos ?? (saved.view === 'tab' ? 'bottom' : 'off'),
  });
} catch { /* keep defaults */ }

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// Per-chart display offsets (ms), added on top of the global offsetMs.
const CHART_OFFSETS_KEY = 'dtx-chart-offsets';
let chartOffsets = {};
try { chartOffsets = JSON.parse(localStorage.getItem(CHART_OFFSETS_KEY) || '{}') || {}; } catch { /* keep empty */ }
let currentChartKey = null; // `${songId}::${chartPath}` of the loaded chart

function chartOffset() {
  return currentChartKey ? (chartOffsets[currentChartKey] || 0) : 0;
}

function applyOffset() {
  player?.setOffset(settings.offsetMs / 1000, chartOffset() / 1000);
}

function applySettings(p) {
  p.speed = settings.scroll;
  p.setTabPos(settings.tabPos);
  p.setTabZoom(settings.tabZoom);
  p.setOffset(settings.offsetMs / 1000, chartOffset() / 1000);
  p.setPlaySpeed(settings.playSpeed);
  p.setVolume(settings.volMaster);
  p.setBgmVolume(settings.volBgm);
  p.setNotesVolume(settings.volNotes);
  p.setColors(settings.colors);
  p.setDisplay(settings.display);
  p.setGroups(settings.groups);       // rebuilds lanes,
  p.setHiddenLanes(settings.hiddenLanes);
  p.setLaneOrder(settings.laneOrder); // so order last
  p.setSkin(currentSkin);
}

// ---- DTXMania skins ----

let currentSkin = null;   // loaded Skin instance, or null = procedural
let loadedSkinId = null;  // skin id currentSkin was decoded from
let skinGen = 0;          // discards stale loads on rapid switching

// Loads settings.skinId into ImageBitmaps (lazily, cached) and hands it to
// the player. Safe to call fire-and-forget.
async function applySkin() {
  const id = settings.skinId || null;
  if (id === loadedSkinId) {
    player?.setSkin(currentSkin);
    return;
  }
  const gen = ++skinGen;
  let next = null;
  if (id) {
    try {
      next = await Skin.load(id);
    } catch (err) {
      console.warn('Failed to load skin', err);
    }
  }
  if (gen !== skinGen) { next?.dispose(); return; } // superseded
  currentSkin?.dispose();
  currentSkin = next;
  loadedSkinId = next ? id : null;
  player?.setSkin(currentSkin);
}

// ---- helpers ----

function showOverlay(text) {
  el.overlayText.textContent = text;
  el.overlay.hidden = false;
}
function hideOverlay() {
  el.overlay.hidden = true;
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtLevel(l) {
  if (l == null) return null;
  // #DLEVEL is usually an integer out of 100; show DTXMania-style x.xx.
  const v = l > 10 ? l / 10 : l;
  return v.toFixed(2);
}

function fmtSize(bytes) {
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + ' GB';
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

// ---- import ----

// entries: [{ path (original, /-separated), data: Blob }]
// Video files (BGA/AVI). The player shows no video, and they are often the
// largest files in a package, so imports skip them unless settings.keepVideos.
const VIDEO_EXTS = new Set(['.avi', '.mp4', '.m4v', '.mov', '.wmv', '.mpg', '.mpeg', '.webm', '.mkv', '.flv', '.ogv', '.asf']);

function isVideoPath(path) {
  const i = path.lastIndexOf('.');
  return i >= 0 && VIDEO_EXTS.has(path.slice(i).toLowerCase());
}

const skipVideo = () => (settings.keepVideos ? null : isVideoPath);

// "Skipped 2 video files (180.3 MB) …" for an import summary, or ''.
function skippedVideosNote(skipped) {
  if (!skipped.length) return '';
  const bytes = skipped.reduce((a, f) => a + (f.size || 0), 0);
  return `Skipped ${skipped.length} video file${skipped.length > 1 ? 's' : ''} (${fmtSize(bytes)}): ` +
    'the player doesn\u2019t show videos. Settings \u2192 Storage \u2192 Keep videos stores them anyway.';
}

// addSong with a readable message when the browser is out of storage, and a
// request (once granted, it sticks) that the library not be evicted.
async function storeSong(song, files) {
  try {
    await addSong(song, files);
  } catch (err) {
    if (err?.name !== 'QuotaExceededError') throw err;
    let free = '';
    try {
      const { usage, quota } = await navigator.storage.estimate();
      free = ` About ${fmtSize(Math.max(0, quota - usage))} is free for this site.`;
    } catch { /* estimate unavailable */ }
    throw new Error(`Not enough storage space: "${song.title}" needs ${fmtSize(song.size)}.${free} ` +
      'Delete songs or remove videos in Settings \u2192 Storage.');
  }
  navigator.storage?.persist?.().catch(() => {});
}

const readText = async (blob) => decodeText(await blob.arrayBuffer());

// Import a folder tree (ZIP, URL or folder) into the box that is open:
// DTXMania folder rules (library.js scanTree) give boxes and songs. Each
// song is stored in its own transaction, so a failure loses only that song.
// Boxes that already exist (same parent and folder name) are reused, and a
// song already in the library (same box, folder and charts) is skipped, so
// re-importing an updated library adds only what's new.
// Returns { imported, duplicates, failed: [{ title, error }], boxes, stopped }.
async function importTree(fallbackTitle, entries) {
  showOverlay('Reading charts…');
  const { boxes, songs } = await scanTree(entries, readText);
  if (!songs.length) throw new Error('No .dtx files found in the import.');

  const base = libraryBox();
  const keyToId = new Map();
  let newBoxes = 0;
  if (boxes.length) {
    await updateBoxes((list) => {
      keyToId.clear();
      newBoxes = 0;
      for (const b of boxes) {
        const parent = b.parentKey == null ? base : keyToId.get(b.parentKey) ?? base;
        const folder = b.folder.toLowerCase();
        const existing = list.find((x) => (x.parent ?? null) === parent && (x.folder || '').toLowerCase() === folder);
        if (existing) { keyToId.set(b.key, existing.id); continue; }
        const id = newId();
        keyToId.set(b.key, id);
        list.push({
          id, parent, title: b.title, genre: b.genre, color: b.color, comment: b.comment,
          artist: b.artist, folder: b.folder, def: b.def, addedAt: Date.now(),
        });
        newBoxes++;
      }
    });
  }

  const songKey = (box, folder, paths) => `${box ?? ''}\n${(folder || '').toLowerCase()}\n${[...paths].sort().join('\n')}`;
  const have = new Set((await listSongs()).map((s) => songKey(s.box ?? null, s.folder, s.dtxs.map((d) => d.path))));

  const res = { imported: 0, duplicates: 0, failed: [], boxes: newBoxes, stopped: false };
  for (let i = 0; i < songs.length; i++) {
    const sc = songs[i];
    const box = sc.boxKey == null ? base : keyToId.get(sc.boxKey) ?? base;
    const title = sc.title || fallbackTitle;
    const key = songKey(box, sc.folder, sc.dtxs.map((d) => d.path));
    if (have.has(key)) { res.duplicates++; continue; }
    el.overlayText.textContent = songs.length > 1 ? `Importing ${i + 1} / ${songs.length} — ${title}` : `Importing ${title}…`;
    const song = {
      id: newId(),
      title,
      artist: sc.artist,
      genre: sc.genre,
      dtxs: sc.dtxs,
      addedAt: Date.now(),
      size: sc.files.reduce((a, f) => a + f.blob.size, 0),
      box,
      folder: sc.folder,
    };
    try {
      await storeSong(song, sc.files);
      have.add(key);
      res.imported++;
    } catch (err) {
      console.error(err);
      res.failed.push({ title, error: err.message });
      if (/storage space/i.test(err.message)) { res.stopped = true; break; } // the rest won't fit either
    }
  }
  return res;
}

// "Imported 37 songs, 2 boxes · 3 already in the library · …" for a
// multi-song import, or '' for a plain single-song import that worked.
function importSummary(r) {
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  if (r.imported <= 1 && !r.duplicates && !r.failed.length && !r.boxes) return '';
  const boxes = r.boxes ? ` and ${r.boxes} new box${r.boxes === 1 ? '' : 'es'}` : '';
  const bits = [`Imported ${n(r.imported, 'song')}${boxes}.`];
  if (r.duplicates) bits.push(`${n(r.duplicates, 'song')} already in the library ${r.duplicates === 1 ? 'was' : 'were'} skipped.`);
  if (r.failed.length) {
    bits.push(`${n(r.failed.length, 'song')} failed:`);
    for (const f of r.failed.slice(0, 8)) bits.push(`  • ${f.title}: ${f.error}`);
    if (r.failed.length > 8) bits.push(`  • … and ${r.failed.length - 8} more`);
  }
  if (r.stopped) bits.push('The import stopped because storage is full.');
  return bits.join('\n');
}

function importNotes(...notes) {
  const text = notes.filter(Boolean).join('\n\n');
  if (text) alert(text);
}

// Guitar Pro: each drum track becomes a generated .dtx chart played with a
// synthesized kit. The original file and a beat-domain model are stored too,
// so charts can be regenerated (e.g. re-timed to a recording) later.
// audio: the attached recording; barTimes: an alignment's measure starts
// (audio seconds); align: its summary; pins: [{ bar, time }] marked by ear.
// stems: drum separation of the recording (separate.js), or null:
// { files: { nodrums, kick, snare, … }: stored paths, models, backend, at, use }.
// With use on, the drumless backing plays as BGM and every drum note plays
// its own hit sliced from the stems (stemslice.js).
// feet: foot-assignment options (feet.js) plus per-chart note edits,
// { [chartPath]: { [key]: action } }. Off unless chosen at import or in
// Settings, so songs imported before this feature stay as they were.
const NO_FEET = { ...DEFAULT_FEET, kickSplit: false, hhClose: false, edits: {} };
const NO_SYNC = { audio: null, kit: true, shiftMs: 0, barTimes: null, align: null, pins: [], feet: NO_FEET, stems: null };
const NO_TIMING = { shiftMs: 0, barTimes: null, align: null, pins: [] };

function feetOf(sync) {
  return { ...NO_FEET, ...sync?.feet };
}

// The chart model with feet assigned, for one chart of a song.
function footedModel(model, sync, path) {
  const feet = feetOf(sync);
  return assignFeet(model, feet, feet.edits[path] || {});
}

// DTX text for a Guitar Pro chart under a song's sync state: the score's own
// timing with no recording, else timed to the recording placed as BGM.
// path: the chart's .dtx path, which keys its note edits.
function gpChartText(source, sync, path) {
  const model = footedModel(source, sync, path);
  const kitVolume = sync.kit === false ? 0 : 100;
  if (!sync.audio) return writeDtx(model, model.tempos, { wavs: KIT_FILES, kitVolume });
  const timed = buildTimedChart(model, barTimesForSync(model, sync));
  const bgm = stemsInUse(sync) ? sync.stems.files.nodrums : sync.audio.path;
  return writeDtx(timed.model, timed.tempos, {
    wavs: KIT_FILES, kitVolume, bgm: { file: bgm, ...timed.bgm },
  });
}

function stemsInUse(sync) {
  return !!(sync?.audio && sync.stems?.use && sync.stems.files?.nodrums);
}

function dtxBlob(text) {
  return new Blob(['﻿' + text], { type: 'text/plain' });
}

// feetOpts: { kickSplit, hhClose } chosen in the import dialog.
async function importGuitarPro(file, feetOpts = {}) {
  const sync = { ...NO_SYNC, feet: { ...NO_FEET, ...feetOpts } };
  showOverlay(`Reading ${file.name}…`);
  const gp = await convertGuitarPro(new Uint8Array(await file.arrayBuffer()));
  showOverlay(`Importing ${file.name}…`);
  const kit = await renderDrumKit();

  const files = [{ path: normPath('source/' + basename(file.name)), origPath: file.name, blob: file }];
  for (const k of kit.values()) files.push({ path: k.file, origPath: k.file, blob: k.blob });

  const dtxs = [];
  const warnings = [];
  gp.charts.forEach((chart, i) => {
    const stem = gp.charts.length > 1 ? `drums-${i + 1}` : 'drums';
    files.push({ path: stem + '.dtx', origPath: stem + '.dtx', blob: dtxBlob(gpChartText(chart.model, sync, stem + '.dtx')) });
    files.push({ path: stem + '.model.json', origPath: stem + '.model.json', blob: new Blob([JSON.stringify(chart.model)], { type: 'application/json' }) });
    dtxs.push({
      path: stem + '.dtx',
      title: chart.model.title || stem,
      label: chart.name,
      level: null,
      bpm: Math.round(chart.model.tempos[0].bpm * 100) / 100,
      model: stem + '.model.json',
    });
    for (const w of chart.warnings) warnings.push(gp.charts.length > 1 ? `${chart.name}: ${w}` : w);
  });

  const song = {
    id: newId(),
    title: gp.title || file.name.replace(/\.[^.]+$/, ''),
    artist: gp.artist || '',
    dtxs,
    addedAt: Date.now(),
    size: files.reduce((a, f) => a + f.blob.size, 0),
    source: 'guitarpro',
    sync,
    box: libraryBox(),
  };
  await storeSong(song, files);
  return warnings;
}

// Asks how to assign feet for the Guitar Pro files being imported.
// Resolves to { kickSplit, hhClose }, or null when cancelled.
function askGpImportOptions(names) {
  const dlg = $('gp-import');
  const kick = $('gp-kick-split');
  const hh = $('gp-hh-close');
  kick.checked = settings.gpFeet?.kickSplit !== false;
  hh.checked = settings.gpFeet?.hhClose !== false;
  $('gp-import-files').textContent = names.join(', ');
  return new Promise((resolve) => {
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      settings.gpFeet = { kickSplit: kick.checked, hhClose: hh.checked };
      saveSettings();
      resolve({ ...settings.gpFeet });
    };
    dlg.returnValue = '';
    dlg.showModal();
  });
}

async function importZipFiles(fileList) {
  const gpNames = fileList.filter((f) => isGuitarProFile(f.name)).map((f) => f.name);
  const gpOpts = gpNames.length ? await askGpImportOptions(gpNames) : null;
  const skipped = [];
  const summaries = [];
  for (const file of fileList) {
    if (isGuitarProFile(file.name)) {
      if (!gpOpts) continue; // dialog cancelled
      try {
        const warnings = await importGuitarPro(file, gpOpts);
        if (warnings.length) alert(`Imported ${file.name} with warnings:\n\n${warnings.join('\n')}`);
      } catch (err) {
        console.error(err);
        alert(`Failed to import ${file.name}:\n${err.message}`);
      }
      continue;
    }
    try {
      showOverlay(`Extracting ${file.name}…`);
      const entries = await extractZip(file, { skip: skipVideo() });
      const r = await importTree(
        file.name.replace(/\.zip$/i, ''),
        entries.map((e) => ({ path: e.name, blob: e.blob })),
      );
      skipped.push(...entries.skipped);
      summaries.push(fileList.length > 1 && importSummary(r) ? `${file.name}: ${importSummary(r)}` : importSummary(r));
    } catch (err) {
      console.error(err);
      alert(`Failed to import ${file.name}:\n${err.message}`);
    }
  }
  hideOverlay();
  await renderSongList();
  importNotes(...summaries, skippedVideosNote(skipped));
}

async function importFromUrl() {
  const url = (prompt('URL of a ZIP containing .dtx charts and audio:') || '').trim();
  if (!url) return;
  try {
    showOverlay('Downloading…');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

    let zip;
    const total = Number(resp.headers.get('Content-Length')) || 0;
    if (resp.body && total) {
      const reader = resp.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        el.overlayText.textContent = `Downloading… ${fmtSize(got)} / ${fmtSize(total)}`;
      }
      zip = new Blob(parts);
    } else {
      zip = await resp.blob();
    }

    const name = decodeURIComponent(
      new URL(url, location.href).pathname.split('/').pop() || 'download.zip',
    );
    showOverlay(`Extracting ${name}…`);
    const entries = await extractZip(zip, { skip: skipVideo() });
    const r = await importTree(
      name.replace(/\.zip$/i, ''),
      entries.map((e) => ({ path: e.name, blob: e.blob })),
    );
    hideOverlay();
    await renderSongList();
    importNotes(importSummary(r), skippedVideosNote(entries.skipped));
  } catch (err) {
    console.error(err);
    const corsHint = err instanceof TypeError
      ? '\n\nThis is usually a CORS restriction or a network error: the server hosting '
        + 'the file must allow cross-origin requests. If it does not, download the ZIP '
        + 'in your browser and use "Import ZIP" instead.'
      : '';
    alert(`Failed to import from URL:\n${err.message}${corsHint}`);
  }
  hideOverlay();
  await renderSongList();
}

async function importFolder(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  try {
    showOverlay('Importing folder…');
    const root = (files[0].webkitRelativePath || files[0].name).split('/')[0];
    const skip = skipVideo();
    const skipped = [];
    const kept = [];
    for (const f of files) {
      const path = f.webkitRelativePath || f.name;
      if (skip?.(path)) skipped.push({ name: path, size: f.size });
      else kept.push({ path, blob: f });
    }
    const r = await importTree(root, kept);
    hideOverlay();
    await renderSongList();
    importNotes(importSummary(r), skippedVideosNote(skipped));
    return;
  } catch (err) {
    console.error(err);
    alert(`Failed to import folder:\n${err.message}`);
  }
  hideOverlay();
  await renderSongList();
}

// ---- library: boxes, search, song list ----

const LIB_BOX_KEY = 'dtx-library-box';
const LIB_PAGE = 200;
let libSongs = [];       // every song record, as last read
let libBoxes = [];       // the box tree
let libHay = new Map();  // song id -> normalised search text
let curBox = null;       // id of the open box, null = top level
try { curBox = localStorage.getItem(LIB_BOX_KEY) || null; } catch { /* storage blocked */ }
let libShown = LIB_PAGE; // result cards shown while searching
let libGen = 0;          // only the newest render paints

// The open box, if it still exists.
function libraryBox() {
  return curBox && libBoxes.some((b) => b.id === curBox) ? curBox : null;
}

function enterBox(id) {
  curBox = id || null;
  try {
    if (curBox) localStorage.setItem(LIB_BOX_KEY, curBox);
    else localStorage.removeItem(LIB_BOX_KEY);
  } catch { /* storage blocked */ }
  libShown = LIB_PAGE;
  paintLibrary();
  el.songList.scrollTop = 0;
}

const songBox = (song) => (song.box && libBoxes.some((b) => b.id === song.box) ? song.box : null);
const boxTitle = (b) => b.title || b.folder || 'Untitled box';
const boxPathText = (id) => ['Library', ...boxPathOf(libBoxes, id).map(boxTitle)].join(' › ');

async function renderSongList() {
  const gen = ++libGen;
  let songs, boxes;
  try {
    [songs, boxes] = await Promise.all([listSongs(), getBoxes()]);
  } catch (err) {
    console.error(err);
    alert(`Couldn’t read the library:\n${err.message}`);
    return;
  }
  if (gen !== libGen) return;
  libSongs = songs;
  libBoxes = boxes;
  const paths = new Map();
  libHay = new Map(songs.map((s) => {
    const b = songBox(s);
    if (!paths.has(b)) paths.set(b, boxPathOf(boxes, b));
    return [s.id, songHaystack(s, paths.get(b))];
  }));
  paintLibrary();
  backfillArtists(songs.filter((s) => s.artist === undefined));
}

function libFilters() {
  const num = (id) => {
    const v = $(id).value.trim();
    return v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  return {
    levelMin: num('flt-lvl-min'), levelMax: num('flt-lvl-max'),
    bpmMin: num('flt-bpm-min'), bpmMax: num('flt-bpm-max'),
    kind: $('flt-kind').value,
  };
}

const filtersActive = (f) => f.levelMin != null || f.levelMax != null || f.bpmMin != null || f.bpmMax != null || !!f.kind;

function paintLibrary() {
  const box = libraryBox();
  if (curBox && !box) curBox = null;
  const terms = searchTerms($('lib-search').value);
  const filters = libFilters();
  const searching = terms.length > 0 || filtersActive(filters);
  $('btn-clear-filters').hidden = !filtersActive(filters);
  paintCrumbs(box, searching);
  const sort = SORTS[settings.libSort] || SORTS.title;
  el.emptyHint.hidden = libSongs.length > 0 || libBoxes.length > 0;

  const items = [];
  if (searching) {
    const scope = $('lib-scope').value === 'box' && box ? descendantIds(libBoxes, box) : null;
    const hits = libSongs.filter((s) => (!scope || scope.has(songBox(s)))
      && (!terms.length || matchTerms(libHay.get(s.id) || '', terms))
      && passesFilters(s, filters)).sort(sort);
    for (const s of hits.slice(0, libShown)) items.push(safeCard(() => songCard(s, { pathChip: true }), s));
    if (!hits.length) items.push(libNote('lib-empty', 'No songs match.'));
    if (hits.length > libShown) {
      const more = document.createElement('li');
      more.className = 'lib-more';
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = `Show more (${hits.length - libShown} left)`;
      btn.onclick = () => { libShown += LIB_PAGE; paintLibrary(); };
      more.append(btn);
      items.push(more);
    }
  } else {
    const counts = boxSongCounts();
    const kids = libBoxes.filter((b) => (b.parent ?? null) === box)
      .sort((a, b) => SORTS.title({ title: boxTitle(a) }, { title: boxTitle(b) }));
    for (const b of kids) items.push(safeCard(() => boxCard(b, counts), null));
    const songs = libSongs.filter((s) => songBox(s) === box).sort(sort);
    for (const s of songs) items.push(safeCard(() => songCard(s), s));
    if (!items.length && (libSongs.length || libBoxes.length)) {
      items.push(libNote('lib-empty', box ? 'This box is empty. Import songs while it is open, or move songs here from their ⋯ menu.' : 'Nothing here.'));
    }
  }
  el.songList.replaceChildren(...items);
}

function libNote(cls, text) {
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = text;
  return li;
}

// A card that fails to build becomes a "damaged" card with Delete, so one
// bad record can't hide the rest of the list.
function safeCard(build, song) {
  try {
    return build();
  } catch (err) {
    console.error('card failed', song?.id, err);
    const li = document.createElement('li');
    li.className = 'song-card damaged';
    const head = document.createElement('div');
    head.className = 'song-head';
    const title = document.createElement('span');
    title.className = 'song-title';
    title.textContent = `${song?.title || 'Unknown item'} (damaged)`;
    head.append(title);
    if (song?.id) {
      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = 'Delete';
      del.onclick = () => removeSong(song);
      head.append(del);
    }
    const meta = document.createElement('div');
    meta.className = 'song-meta';
    meta.textContent = 'This entry couldn’t be shown.';
    li.append(head, meta);
    return li;
  }
}

function paintCrumbs(box, searching) {
  const nav = $('lib-crumbs');
  const parts = [];
  const trail = [{ id: null, title: 'Library' }, ...boxPathOf(libBoxes, box).map((b) => ({ id: b.id, title: boxTitle(b) }))];
  trail.forEach((c, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      parts.push(sep);
    }
    if (i === trail.length - 1 && !searching) {
      const here = document.createElement('span');
      here.className = 'crumb-here';
      here.textContent = c.title;
      parts.push(here);
    } else {
      const b = document.createElement('button');
      b.textContent = c.title;
      b.onclick = () => { clearSearch(); enterBox(c.id); };
      parts.push(b);
    }
  });
  if (searching) {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '›';
    const here = document.createElement('span');
    here.className = 'crumb-here';
    here.textContent = 'Search';
    parts.push(sep, here);
  }
  nav.replaceChildren(...parts);
}

// Songs in each box including its sub-boxes.
function boxSongCounts() {
  const direct = new Map();
  for (const s of libSongs) {
    const b = songBox(s);
    direct.set(b, (direct.get(b) || 0) + 1);
  }
  const total = new Map();
  const kids = new Map();
  for (const b of libBoxes) {
    const p = b.parent ?? null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(b.id);
  }
  const visit = (id, seen) => {
    if (total.has(id)) return total.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    let n = direct.get(id) || 0;
    for (const k of kids.get(id) || []) n += visit(k, seen);
    total.set(id, n);
    return n;
  };
  for (const b of libBoxes) visit(b.id, new Set());
  return { total, kids };
}

function boxCard(b, counts) {
  const li = document.createElement('li');
  li.className = 'box-card';
  if (b.color) li.style.setProperty('--box-color', b.color);
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  const head = document.createElement('div');
  head.className = 'song-head';
  const title = document.createElement('span');
  title.className = 'song-title';
  title.textContent = boxTitle(b);
  title.title = boxTitle(b);
  const menuBtn = document.createElement('button');
  menuBtn.className = 'btn small card-menu-btn';
  menuBtn.textContent = '⋯';
  menuBtn.title = 'More actions';
  menuBtn.onclick = (e) => { e.stopPropagation(); showBoxMenu(menuBtn, b); };
  head.append(title, menuBtn);
  const meta = document.createElement('div');
  meta.className = 'song-meta';
  const n = counts.total.get(b.id) || 0;
  const sub = (counts.kids.get(b.id) || []).length;
  meta.textContent = [b.genre, `${n} song${n === 1 ? '' : 's'}`, sub ? `${sub} box${sub === 1 ? '' : 'es'}` : '']
    .filter(Boolean).join(' · ');
  li.append(head, meta);
  if (b.comment) {
    const c = document.createElement('div');
    c.className = 'song-meta';
    c.textContent = b.comment;
    li.append(c);
  }
  li.onclick = () => enterBox(b.id);
  li.onkeydown = (e) => { if (e.key === 'Enter' && e.target === li) enterBox(b.id); };
  return li;
}

async function removeSong(song) {
  if (!confirm(`Delete "${song.title}" from this browser?`)) return;
  await deleteSong(song.id);
  let pruned = false;
  for (const key of Object.keys(chartOffsets)) {
    if (key.startsWith(song.id + '::')) { delete chartOffsets[key]; pruned = true; }
  }
  if (pruned) localStorage.setItem(CHART_OFFSETS_KEY, JSON.stringify(chartOffsets));
  renderSongList();
}

function songCard(song, { pathChip = false } = {}) {
  const li = document.createElement('li');
  li.className = 'song-card';

  const head = document.createElement('div');
  head.className = 'song-head';
  const title = document.createElement('span');
  title.className = 'song-title';
  title.textContent = song.title;
  title.title = song.title;
  const menuBtn = document.createElement('button');
  menuBtn.className = 'btn small card-menu-btn';
  menuBtn.textContent = '⋯';
  menuBtn.title = 'More actions';
  menuBtn.onclick = () => showCardMenu(menuBtn, song);
  const del = document.createElement('button');
  del.className = 'btn small danger';
  del.textContent = 'Delete';
  del.onclick = () => removeSong(song);
  head.append(title, menuBtn, del);
  li.append(head);

  if (pathChip) {
    const chip = document.createElement('button');
    chip.className = 'path-chip';
    chip.textContent = boxPathText(songBox(song));
    chip.title = 'Open this box';
    chip.onclick = () => { clearSearch(); enterBox(songBox(song)); };
    li.append(chip);
  }

  const info = document.createElement('div');
  info.className = 'song-info';
  info.textContent = songInfoText(song);
  info.title = info.textContent;
  info.hidden = !info.textContent;
  info.dataset.songId = song.id;

  const meta = document.createElement('div');
  meta.className = 'song-meta';
  const kind = song.source === 'guitarpro' ? (song.sync?.audio ? 'Guitar Pro + recording · ' : 'Guitar Pro · ') : '';
  meta.textContent = `${kind}${song.dtxs.length} chart${song.dtxs.length > 1 ? 's' : ''} · ${fmtSize(song.size)} · added ${new Date(song.addedAt).toLocaleDateString()}`;

  const charts = document.createElement('div');
  charts.className = 'charts';
  for (const d of song.dtxs) {
    const btn = document.createElement('button');
    btn.className = 'chart-btn';
    const name = document.createElement('span');
    name.textContent = d.label || d.title || basename(d.path);
    btn.append(name);
    const lvl = fmtLevel(d.level);
    if (lvl) {
      const badge = document.createElement('span');
      badge.className = 'lvl';
      badge.textContent = lvl;
      btn.append(badge);
    }
    btn.onclick = () => openChartFromLibrary(song, d);
    charts.append(btn);
  }

  li.append(info, meta, charts);
  return li;
}

// Open from a card with the record as stored now, not the card's copy (it
// may predate an attach, alignment or other change).
async function openChartFromLibrary(song, chartInfo) {
  const fresh = await getSong(song.id).catch(() => null);
  if (!fresh) {
    alert('This song is no longer in the library.');
    renderSongList();
    return;
  }
  openChart(fresh, fresh.dtxs.find((d) => d.path === chartInfo.path) || chartInfo);
}

const fmtBpm = (b) => String(Math.round(b * 100) / 100);

// "Artist · BPM 140" (or a range when the charts disagree).
function songInfoText(song) {
  const bits = [];
  if (song.artist) bits.push(song.artist);
  const bpms = song.dtxs.map((d) => d.bpm).filter((b) => Number.isFinite(b) && b > 0);
  if (bpms.length) {
    const lo = Math.min(...bpms), hi = Math.max(...bpms);
    bits.push(Math.abs(hi - lo) < 0.005 ? `BPM ${fmtBpm(lo)}` : `BPM ${fmtBpm(lo)}–${fmtBpm(hi)}`);
  }
  return bits.join(' · ');
}

// Songs imported before artists were stored: read it from the first chart's
// header once and save only that field (patchSong edits the stored record,
// so a slow pass can't overwrite newer changes or bring back a deleted song).
const backfilling = new Set();
async function backfillArtists(list) {
  for (const song of list) {
    if (backfilling.has(song.id)) continue;
    backfilling.add(song.id);
    try {
      const files = await getSongFiles(song.id);
      const blob = files.find((f) => f.path === song.dtxs[0]?.path)?.blob;
      let artist = '';
      if (blob) artist = parseDTX(await readText(blob), { headersOnly: true }).artist || '';
      const saved = await patchSong(song.id, (s) => {
        if (s.artist !== undefined) return false;
        s.artist = artist;
      });
      const now = saved?.artist ?? artist;
      const cached = libSongs.find((s) => s.id === song.id);
      if (cached) cached.artist = now;
      for (const info of el.songList.querySelectorAll('.song-info')) {
        if (info.dataset.songId !== song.id) continue;
        info.textContent = songInfoText({ ...song, artist: now });
        info.title = info.textContent;
        info.hidden = !info.textContent;
      }
    } catch (err) {
      console.warn('artist backfill failed', song.id, err);
    }
    backfilling.delete(song.id);
  }
}

// ---- search & filters ----

function clearSearch() {
  $('lib-search').value = '';
  libShown = LIB_PAGE;
}

let searchTimer = null;
$('lib-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { libShown = LIB_PAGE; paintLibrary(); }, 120);
});
$('lib-search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    if ($('lib-search').value) { clearSearch(); paintLibrary(); } else $('lib-search').blur();
  }
});
for (const id of ['lib-scope', 'flt-kind', 'flt-lvl-min', 'flt-lvl-max', 'flt-bpm-min', 'flt-bpm-max']) {
  $(id).addEventListener('input', () => { libShown = LIB_PAGE; paintLibrary(); });
}
$('lib-sort').value = SORTS[settings.libSort] ? settings.libSort : 'title';
$('lib-sort').addEventListener('change', () => {
  settings.libSort = $('lib-sort').value;
  saveSettings();
  paintLibrary();
});
$('btn-clear-filters').onclick = () => {
  for (const id of ['flt-lvl-min', 'flt-lvl-max', 'flt-bpm-min', 'flt-bpm-max']) $(id).value = '';
  $('flt-kind').value = '';
  paintLibrary();
};

// ---- boxes: create, edit, move, delete ----

function askBox(heading, init = {}) {
  const dlg = $('box-dialog');
  $('box-dialog-title').textContent = heading;
  $('box-title').value = init.title || '';
  $('box-genre').value = init.genre || '';
  const hex = /^#[0-9a-f]{6}$/i.test(init.color || '') ? init.color : '#ffffff';
  $('box-color').value = hex;
  $('box-color-on').checked = !!init.color;
  $('box-color').oninput = () => { $('box-color-on').checked = true; };
  return new Promise((resolve) => {
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') { resolve(null); return; }
      resolve({
        title: $('box-title').value.trim(),
        genre: $('box-genre').value.trim(),
        // Keep a named colour (box.def allows "White") unless it was changed.
        color: $('box-color-on').checked
          ? ($('box-color').value.toLowerCase() === hex.toLowerCase() && init.color ? init.color : $('box-color').value)
          : '',
      });
    };
    dlg.returnValue = '';
    dlg.showModal();
  });
}

$('btn-new-box').onclick = async () => {
  const v = await askBox('New box');
  if (!v?.title) return;
  const parent = libraryBox();
  await updateBoxes((list) => {
    list.push({ id: newId(), parent, title: v.title, genre: v.genre, color: v.color, comment: '', artist: '', folder: '', def: '', addedAt: Date.now() });
  });
  await renderSongList();
};

async function editBox(b) {
  const v = await askBox('Edit box', b);
  if (!v?.title) return;
  await updateBoxes((list) => {
    const x = list.find((y) => y.id === b.id);
    if (!x) return false;
    Object.assign(x, v);
  });
  await renderSongList();
}

// Pick a destination box. disabled: box ids that can't be chosen.
function pickBox(heading, disabled = new Set(), here = null) {
  const dlg = $('move-dialog');
  $('move-dialog-title').textContent = heading;
  const ul = $('move-tree');
  const kids = new Map();
  for (const b of libBoxes) {
    const p = b.parent && libBoxes.some((x) => x.id === b.parent) ? b.parent : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(b);
  }
  const rows = [];
  return new Promise((resolve) => {
    const add = (id, label, depth) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.style.paddingLeft = `${8 + depth * 18}px`;
      btn.disabled = disabled.has(id);
      if (id === here) { btn.classList.add('here'); btn.textContent += ' (current)'; btn.disabled = true; }
      btn.onclick = () => { resolve({ id }); dlg.onclose = null; dlg.close(); };
      li.append(btn);
      rows.push(li);
    };
    const walk = (p, depth, seen) => {
      for (const b of (kids.get(p) || []).sort((x, y) => SORTS.title({ title: boxTitle(x) }, { title: boxTitle(y) }))) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        add(b.id, `▸ ${boxTitle(b)}`, depth);
        walk(b.id, depth + 1, seen);
      }
    };
    add(null, 'Library (top level)', 0);
    walk(null, 1, new Set());
    ul.replaceChildren(...rows);
    dlg.onclose = () => resolve(null);
    dlg.showModal();
  });
}

async function moveSong(song) {
  const dest = await pickBox(`Move “${song.title}” to…`, new Set(), songBox(song));
  if (!dest) return;
  await patchSong(song.id, (s) => { s.box = dest.id; });
  await renderSongList();
}

async function moveBox(b) {
  const banned = descendantIds(libBoxes, b.id);
  const dest = await pickBox(`Move box “${boxTitle(b)}” to…`, banned, b.parent ?? null);
  if (!dest) return;
  await updateBoxes((list) => {
    const x = list.find((y) => y.id === b.id);
    if (!x || descendantIds(list, b.id).has(dest.id)) return false; // never into itself
    x.parent = dest.id;
  });
  await renderSongList();
}

// Delete a box. withContents: also delete every song and box inside it;
// otherwise they move up to the box's parent.
async function deleteBox(b, withContents) {
  const ids = descendantIds(libBoxes, b.id);
  const inside = libSongs.filter((s) => ids.has(songBox(s)));
  const direct = libSongs.filter((s) => songBox(s) === b.id);
  const parent = b.parent && libBoxes.some((x) => x.id === b.parent) ? b.parent : null;
  const where = parent ? `“${boxTitle(libBoxes.find((x) => x.id === parent))}”` : 'the top level';
  const msg = withContents
    ? `Delete the box “${boxTitle(b)}” and everything in it: ${inside.length} song${inside.length === 1 ? '' : 's'}`
      + ` and ${ids.size - 1} box${ids.size - 1 === 1 ? '' : 'es'}? This can’t be undone.`
    : `Delete the box “${boxTitle(b)}”? Its songs and boxes move to ${where}.`;
  if (!confirm(msg)) return;
  try {
    showOverlay('Deleting…');
    if (withContents) {
      for (let i = 0; i < inside.length; i++) {
        el.overlayText.textContent = `Deleting ${i + 1} / ${inside.length}…`;
        await deleteSong(inside[i].id);
      }
      await updateBoxes((list) => {
        const all = descendantIds(list, b.id);
        for (let i = list.length - 1; i >= 0; i--) if (all.has(list[i].id)) list.splice(i, 1);
      });
    } else {
      for (const s of direct) await patchSong(s.id, (x) => { x.box = parent; });
      await updateBoxes((list) => {
        const i = list.findIndex((x) => x.id === b.id);
        if (i < 0) return false;
        list.splice(i, 1);
        for (const x of list) if (x.parent === b.id) x.parent = parent;
      });
    }
  } catch (err) {
    console.error(err);
    alert(`Failed to delete the box:\n${err.message}`);
  }
  hideOverlay();
  if (curBox && !libBoxes.some((x) => x.id === curBox && !ids.has(x.id))) curBox = parent;
  if (ids.has(curBox)) enterBox(parent);
  await renderSongList();
}

function showBoxMenu(btn, b) {
  const reopen = openMenu?.dataset.boxId !== b.id;
  closeCardMenu();
  if (!reopen) return;
  const menu = document.createElement('div');
  menu.className = 'card-menu';
  menu.dataset.boxId = b.id;
  const item = (text, fn, title = '') => {
    const it = document.createElement('button');
    it.className = 'card-menu-item';
    it.textContent = text;
    if (title) it.title = title;
    it.onclick = () => { closeCardMenu(); fn(); };
    menu.append(it);
  };
  item('Edit…', () => editBox(b));
  item('Move to…', () => moveBox(b));
  item('Export', () => exportLibrary(b.id), 'Download this box with its songs as DTXMania folders');
  item('Delete box (keep songs)…', () => deleteBox(b, false));
  item('Delete box and its songs…', () => deleteBox(b, true));
  placeMenu(menu, btn);
}

function placeMenu(menu, btn) {
  const r = btn.getBoundingClientRect();
  document.body.append(menu);
  const h = menu.offsetHeight;
  const below = r.bottom + 4 + h <= window.innerHeight;
  menu.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - 4 - h)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 250))}px`;
  openMenu = menu;
}

$('btn-export-lib').onclick = () => exportLibrary(libraryBox());

// ---- song card menu ----

let openMenu = null;

function closeCardMenu() {
  openMenu?.remove();
  openMenu = null;
}

function showCardMenu(btn, song) {
  const reopen = openMenu?.dataset.songId !== song.id;
  closeCardMenu();
  if (!reopen) return; // second click on the same ⋯ toggles closed
  const menu = document.createElement('div');
  menu.className = 'card-menu';
  menu.dataset.songId = song.id;
  const zipItem = document.createElement('button');
  zipItem.className = 'card-menu-item';
  zipItem.textContent = 'Export ZIP';
  zipItem.title = song.source === 'guitarpro'
    ? 'Download the generated DTX charts with their sounds, recording and the original Guitar Pro file'
    : 'Download this song as a DTX package';
  zipItem.onclick = () => {
    closeCardMenu();
    exportSongZip(song);
  };
  const moveItem = document.createElement('button');
  moveItem.className = 'card-menu-item';
  moveItem.textContent = 'Move to\u2026';
  moveItem.onclick = () => {
    closeCardMenu();
    moveSong(song);
  };
  menu.append(moveItem, zipItem);
  for (const d of song.dtxs) {
    const name = d.label || d.title || basename(d.path);
    const view = document.createElement('button');
    view.className = 'card-menu-item';
    view.textContent = `Chart image — ${name}`;
    view.onclick = () => {
      closeCardMenu();
      openChartViewerFromLibrary(song, d);
    };
    menu.append(view);
    const item = document.createElement('button');
    item.className = 'card-menu-item';
    item.textContent = `Export PDF — ${name}`;
    item.onclick = () => {
      closeCardMenu();
      exportChartPdfFromLibrary(song, d);
    };
    menu.append(item);
  }
  placeMenu(menu, btn);
}

const safeFileName = (s, fallback) => (s || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120) || fallback;

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// The song's stored files under one top folder, re-importable via Import ZIP.
async function exportSongZip(song) {
  try {
    showOverlay('Building ZIP…');
    const folder = safeFileName(song.title, 'song');
    const files = await getSongFiles(song.id);
    if (!files.length) throw new Error('No files stored for this song.');
    // Generated Guitar Pro charts reference the stored paths (a recording's
    // origPath is the user's file name), so use those; DTX packages keep
    // their original names and case.
    const gp = song.source === 'guitarpro';
    const blob = await createZip(files.map((f) => ({
      name: `${folder}/${((gp ? f.path : f.origPath) || f.path).replace(/^\/+/, '')}`,
      blob: f.blob,
    })));
    downloadBlob(blob, `${folder}.zip`);
  } catch (err) {
    console.error(err);
    alert(`Failed to export ZIP:\n${err.message}`);
  }
  hideOverlay();
}

// ---- library export ----

// The whole library (rootId null) or one box as DTXMania folders: every box
// becomes a folder with a box.def, every song its folder inside it. Files
// stay Blob references, so nothing is held in memory whole.
// Returns { top, entries: [{ name, blob }] }.
async function buildLibraryExport(rootId) {
  const [songs, boxes] = await Promise.all([listSongs(), getBoxes()]);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const parentOf = (b) => (b.parent && byId.has(b.parent) ? b.parent : null);
  const inScope = rootId ? descendantIds(boxes, rootId) : null;

  const used = new Map(); // folder path -> Set of lowercased child names
  const uniqueChild = (dir, name) => {
    if (!used.has(dir)) used.set(dir, new Set());
    const set = used.get(dir);
    let n = name, k = 2;
    while (set.has(n.toLowerCase())) n = `${name} (${k++})`;
    set.add(n.toLowerCase());
    return n;
  };
  const boxFolderName = (b) => safeFileName(b.folder || boxTitle(b), 'Box');

  const top = rootId ? boxFolderName(byId.get(rootId)) : 'DTX Library';
  const dirs = new Map();
  const dirOf = (id) => {
    if (id === (rootId ?? null)) return top;
    if (dirs.has(id)) return dirs.get(id);
    const b = byId.get(id);
    const parentDir = dirOf(parentOf(b));
    const d = `${parentDir}/${uniqueChild(parentDir, boxFolderName(b))}`;
    dirs.set(id, d);
    return d;
  };

  const entries = [];
  const sortedBoxes = [...boxes].sort((a, b) => SORTS.title({ title: boxTitle(a) }, { title: boxTitle(b) }));
  for (const b of sortedBoxes) {
    if (inScope && !inScope.has(b.id)) continue;
    const text = writeBoxDef(b.def, { title: boxTitle(b), genre: b.genre || '', color: b.color || '', comment: b.comment || '', artist: b.artist || '' });
    entries.push({ name: `${dirOf(b.id)}/box.def`, blob: new Blob([encodeShiftJIS(text)]) });
  }

  // Song files. Identical paths (shared sounds, a set.def with several
  // songs) are written once; a different file at a taken path moves the
  // song to a renamed folder.
  const written = new Map(); // lowercased name -> size
  for (const song of songs.sort(SORTS.title)) {
    const box = song.box && byId.has(song.box) ? song.box : null;
    if (inScope && !inScope.has(box)) continue;
    const dir = dirOf(box);
    const files = await getSongFiles(song.id);
    if (!files.length) continue;
    const gp = song.source === 'guitarpro';
    let rel = files.map((f) => ((gp ? f.path : f.origPath) || f.path).replace(/^\/+/, ''));
    // Songs imported with their folder keep it; others (older imports, Guitar
    // Pro, single songs from a ZIP root) get one named after the title
    // unless their files already share a top folder.
    const tops = new Set(rel.map((r) => (r.includes('/') ? r.split('/')[0].toLowerCase() : '')));
    const hasFolder = (typeof song.folder === 'string' && song.folder !== '') || (tops.size === 1 && !tops.has(''));
    let prefix = hasFolder ? '' : `${uniqueChild(dir, safeFileName(song.title, 'Song'))}/`;
    const clash = () => rel.some((r) => {
      const size = written.get(`${dir}/${prefix}${r}`.toLowerCase());
      return size !== undefined && size !== files[rel.indexOf(r)].blob.size;
    });
    if (clash()) {
      const first = hasFolder ? rel[0].split('/')[0] : safeFileName(song.title, 'Song');
      const renamed = uniqueChild(dir, first);
      if (hasFolder) rel = rel.map((r) => (r.split('/')[0].toLowerCase() === first.toLowerCase() ? renamed + r.slice(first.length) : r));
      else prefix = `${renamed}/`;
    }
    files.forEach((f, i) => {
      const name = `${dir}/${prefix}${rel[i]}`;
      if (written.has(name.toLowerCase())) return;
      written.set(name.toLowerCase(), f.blob.size);
      entries.push({ name, blob: f.blob });
    });
  }
  return { top, entries };
}

async function writeToFolder(root, entries) {
  const dirCache = new Map([['', root]]);
  const dirHandle = async (path) => {
    if (dirCache.has(path)) return dirCache.get(path);
    const parent = await dirHandle(dirname(path));
    const h = await parent.getDirectoryHandle(basename(path), { create: true });
    dirCache.set(path, h);
    return h;
  };
  for (let i = 0; i < entries.length; i++) {
    el.overlayText.textContent = `Writing ${i + 1} / ${entries.length}…`;
    const { name, blob } = entries[i];
    const dir = await dirHandle(dirname(name));
    const fh = await dir.getFileHandle(basename(name), { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }
}

async function exportLibrary(rootId) {
  const what = rootId ? `the box “${boxTitle(libBoxes.find((b) => b.id === rootId) || {})}”` : 'the whole library';
  // Chromium can write a real folder tree; elsewhere it's a ZIP.
  let folder = null;
  if (window.showDirectoryPicker) {
    const asFolder = confirm(`Export ${what}.\n\nOK: save into a folder you choose (for DTXMania's Songs folder).\nCancel: download a ZIP instead.`);
    if (asFolder) {
      try {
        folder = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        throw err;
      }
    }
  }
  try {
    showOverlay('Collecting files…');
    const { top, entries } = await buildLibraryExport(rootId);
    if (!entries.length) throw new Error('There is nothing to export here.');
    if (folder) {
      await writeToFolder(folder, entries);
      hideOverlay();
      alert(`Exported ${entries.length} files into “${folder.name}/${top}”.`);
    } else {
      const zip = await createZip(entries, {
        onProgress: (i, n) => { el.overlayText.textContent = `Building ZIP… ${i} / ${n}`; },
      });
      downloadBlob(zip, `${top}.zip`);
    }
  } catch (err) {
    console.error(err);
    alert(`Failed to export:\n${err.message}`);
  }
  hideOverlay();
}

document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target) && !e.target.closest?.('.card-menu-btn')) {
    closeCardMenu();
  }
});

// ---- playback ----

// opts.fileMap reuses already-loaded files (and so their decoded audio);
// opts.at starts at that song time; opts.autoplay = false stays paused.
async function openChart(song, chartInfo, { fileMap = null, at = 0, autoplay = true } = {}) {
  try {
    showOverlay('Loading files…');
    if (!fileMap) {
      const stored = await getSongFiles(song.id);
      fileMap = new Map(stored.map((f) => [f.path, f.blob]));
    }

    const dtxBlob = fileMap.get(chartInfo.path);
    if (!dtxBlob) throw new Error('Chart file missing from local storage. Try re-importing the song.');

    const dtx = parseDTX(decodeText(await dtxBlob.arrayBuffer()));
    if (!dtx.chips.length) throw new Error('This chart contains no playable chips.');

    if (!player) {
      player = new Player($('chart'));
      player.onFrame = onPlayerFrame;
      player.onEnded = () => { el.btnPlay.textContent = 'Play'; };
      player.onLoopChange = updateLoopUI;
      player.onChipEdit = editFoot;
      player.onTabZoom = (z) => { // pinch / ctrl+wheel zoom on the strip
        settings.tabZoom = Math.round(z * 100) / 100;
        saveSettings();
        refreshSteppers('tabZoom');
      };
      player.onStretchProgress = (p) => {
        el.overlayText.textContent = `Time-stretching audio… ${Math.round(p * 100)}%`;
      };
      applySettings(player);
    }
    applySkin(); // async; decodes the selected skin on first player use

    currentChartKey = `${song.id}::${chartInfo.path}`;
    applyOffset();
    refreshSteppers('offsetChart');

    const shownBpm = await gpDisplayInfo(song, chartInfo, fileMap, dtx);
    const resolve = makeResolver(fileMap, dirname(chartInfo.path));
    const { missing, failed } = await player.load(dtx, resolve, (done, total) => {
      el.overlayText.textContent = `Decoding audio ${done} / ${total}…`;
    });
    await loadStemKeysounds(song, fileMap, dtx, missing, failed);

    el.npTitle.textContent = dtx.title || song.title;
    const sub = [];
    if (dtx.artist) sub.push(dtx.artist);
    sub.push(`BPM ${shownBpm}`);
    if (chartInfo.label) sub.push(chartInfo.label);
    const lvl = fmtLevel(dtx.level);
    if (lvl) sub.push(`Lv ${lvl}`);
    el.npSub.textContent = sub.join(' · ');

    currentDtx = dtx;
    current = { song, chartInfo, fileMap };
    player.editFeet = editingFeet && song.source === 'guitarpro';
    currentMeta = {
      title: dtx.title || song.title,
      artist: dtx.artist,
      bpm: shownBpm,
      level: lvl,
      label: chartInfo.label,
    };

    const problems = missing.length + failed.length;
    if (problems) {
      el.npWarn.textContent = `⚠ ${problems} sound${problems > 1 ? 's' : ''} unavailable`;
      el.npWarn.title =
        (missing.length ? `Missing files:\n${missing.join('\n')}\n` : '') +
        (failed.length ? `Could not decode (unsupported format, e.g. .wma):\n${failed.join('\n')}` : '');
    } else {
      el.npWarn.textContent = '';
      el.npWarn.title = '';
    }

    el.timeTotal.textContent = fmtTime(player.duration);
    el.screenSelect.hidden = true;
    el.screenPlayer.hidden = false;
    hideOverlay();
    if (!lanePanel.hidden) buildSyncSection();

    if (at > 0) player.seek(at);
    if (!autoplay) {
      el.btnPlay.textContent = 'Play';
      return;
    }
    await player.play();
    el.btnPlay.textContent = 'Pause';

    // iOS: if decoding took long enough that the resume fell outside the
    // original tap gesture, the context may still be suspended. Show "Play"
    // and let the next tap (a real gesture) start audio.
    if (player.ctx.state !== 'running') {
      player.pause();
      el.btnPlay.textContent = 'Play';
      const retry = () => { player?.ctx.resume().catch(() => {}); };
      document.addEventListener('pointerdown', retry, { once: true });
    }
  } catch (err) {
    console.error(err);
    hideOverlay();
    alert(`Failed to load chart:\n${err.message}`);
  }
}

// Write to the DOM only when a value actually changed — unconditional writes
// dirty layout every frame and force a reflow when the canvas reads its size.
let lastTimeCur = '', lastTimeTotal = '', lastSeek = -1;
function onPlayerFrame(p) {
  const cur = fmtTime(p.time);
  if (cur !== lastTimeCur) {
    lastTimeCur = cur;
    el.timeCur.textContent = cur;
  }
  const total = fmtTime(p.duration); // can change with play speed
  if (total !== lastTimeTotal) {
    lastTimeTotal = total;
    el.timeTotal.textContent = total;
  }
  if (!seeking && p.duration > 0) {
    const v = Math.round((Math.min(p.time, p.duration) / p.duration) * 1000);
    if (v !== lastSeek) {
      lastSeek = v;
      el.seek.value = v;
    }
  }
}

function backToSelect() {
  player?.pause();
  el.screenPlayer.hidden = true;
  el.screenSelect.hidden = false;
}

// ---- events ----

$('btn-import-zip').onclick = () => el.fileZip.click();
$('btn-import-url').onclick = () => importFromUrl();
$('btn-import-folder').onclick = () => el.fileFolder.click();
el.fileZip.onchange = () => { importZipFiles([...el.fileZip.files]); el.fileZip.value = ''; };
el.fileFolder.onchange = () => { importFolder(el.fileFolder.files); el.fileFolder.value = ''; };

$('btn-back').onclick = backToSelect;

$('btn-play').onclick = async () => {
  if (!player) return;
  if (player.playing) {
    player.pause();
    el.btnPlay.textContent = 'Play';
  } else {
    await player.play();
    el.btnPlay.textContent = 'Pause';
  }
};

// ---- PDF export ----

// Rasterize a text line via canvas so non-WinAnsi titles (Japanese, …)
// appear in the PDF without font embedding.
function textToImage(text, sizePt, bold) {
  const scale = 4;
  const c = document.createElement('canvas');
  let g = c.getContext('2d');
  const font = `${bold ? '700' : '400'} ${sizePt * scale}px -apple-system, "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 4;
  const h = Math.ceil(sizePt * scale * 1.35);
  c.width = w;
  c.height = h;
  g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#000';
  g.font = font;
  g.fillText(text, 2, Math.round(sizePt * scale * 1.02));
  const src = g.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    rgb[j] = src[i]; rgb[j + 1] = src[i + 1]; rgb[j + 2] = src[i + 2];
  }
  return { width: w, height: h, data: rgb, pxWidth: w / scale, pxHeight: h / scale };
}

async function exportPdf(dtx, meta) {
  try {
    showOverlay('Generating PDF…');
    const { buildScorePdf } = await import('./score.js');
    const bytes = await buildScorePdf({
      title: meta.title,
      artist: meta.artist,
      bpm: meta.bpm,
      level: meta.level,
      chips: dtx.chips,
      bars: dtx.bars,
      beats: dtx.beats,
    }, { textToImage });
    const name = `${meta.title}${meta.label ? ` (${meta.label})` : ''}`
      .replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'score';
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.pdf`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) {
    console.error(err);
    alert(`Failed to generate PDF:\n${err.message}`);
  }
  hideOverlay();
}

$('btn-pdf').onclick = () => {
  if (currentDtx) exportPdf(currentDtx, currentMeta);
};

// Export straight from the library: parse the chart on demand (no audio).
async function exportChartPdfFromLibrary(song, chartInfo) {
  try {
    showOverlay('Loading chart…');
    const stored = await getSongFiles(song.id);
    const fileMap = new Map(stored.map((f) => [f.path, f.blob]));
    const blob = fileMap.get(chartInfo.path);
    if (!blob) throw new Error('Chart file missing from local storage.');
    const dtx = parseDTX(decodeText(await blob.arrayBuffer()));
    const bpm = await gpDisplayInfo(song, chartInfo, fileMap, dtx);
    await exportPdf(dtx, {
      title: dtx.title || song.title,
      artist: dtx.artist,
      bpm,
      level: fmtLevel(dtx.level),
      label: chartInfo.label,
    });
  } catch (err) {
    console.error(err);
    hideOverlay();
    alert(`Failed to export PDF:\n${err.message}`);
  }
}

// ---- static chart viewer ----

let viewerDtx = null;
let viewerMeta = null;

function chartViewerOpts() {
  return {
    colors: settings.colors,
    laneOrder: settings.laneOrder,
    groups: settings.groups,
    hiddenLanes: settings.hiddenLanes,
    background: '#000',
  };
}

async function openChartViewer(dtx, meta) {
  if (!dtx.bars.length || !dtx.chips.length) {
    alert('This chart has no notes to display.');
    return;
  }
  try {
    showOverlay('Rendering chart…');
    const { renderChartView } = await import('./chartview.js');
    viewerDtx = dtx;
    viewerMeta = meta;
    const bits = [meta.title || 'Chart'];
    if (meta.label) bits.push(meta.label);
    if (meta.bpm) bits.push(`BPM ${meta.bpm}`);
    $('chart-view-title').textContent = bits.join(' · ');
    renderChartView($('chart-view'), dtx, chartViewerOpts());
    $('chart-view-panel').hidden = false;
    $('chart-view-wrap').scrollTop = $('chart-view').clientHeight; // start at chart bottom
  } catch (err) {
    console.error(err);
    alert(`Failed to render chart:\n${err.message}`);
  }
  hideOverlay();
}

async function openChartViewerFromLibrary(song, chartInfo) {
  try {
    showOverlay('Loading chart…');
    const stored = await getSongFiles(song.id);
    const fileMap = new Map(stored.map((f) => [f.path, f.blob]));
    const blob = fileMap.get(chartInfo.path);
    if (!blob) throw new Error('Chart file missing from local storage.');
    const dtx = parseDTX(decodeText(await blob.arrayBuffer()));
    const bpm = await gpDisplayInfo(song, chartInfo, fileMap, dtx);
    await openChartViewer(dtx, {
      title: dtx.title || song.title,
      artist: dtx.artist,
      bpm,
      level: fmtLevel(dtx.level),
      label: chartInfo.label,
    });
  } catch (err) {
    console.error(err);
    hideOverlay();
    alert(`Failed to open chart:\n${err.message}`);
  }
}

$('btn-image')?.addEventListener('click', () => {
  if (currentDtx) openChartViewer(currentDtx, currentMeta);
});

$('chart-view-close').onclick = () => {
  $('chart-view-panel').hidden = true;
};

$('chart-view-download').onclick = async () => {
  if (!viewerDtx) return;
  try {
    showOverlay('Saving image…');
    const { exportChartPng } = await import('./chartview.js');
    const blob = await exportChartPng(viewerDtx, chartViewerOpts());
    const name = `${viewerMeta.title || 'chart'}${viewerMeta.label ? ` (${viewerMeta.label})` : ''}`
      .replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'chart';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) {
    console.error(err);
    alert(`Failed to save image:\n${err.message}`);
  }
  hideOverlay();
};

// ---- tab strip & practice loop ----

const TAB_CYCLE = { off: 'bottom', bottom: 'top', top: 'off' };
const TAB_LABEL = { off: 'Tab: Off', bottom: 'Tab: Bottom', top: 'Tab: Top' };

function updateViewButton() {
  const btn = $('btn-view');
  btn.textContent = TAB_LABEL[settings.tabPos] || 'Tab: Off';
  btn.classList.toggle('active', settings.tabPos !== 'off');
  $('tabzoom-wrap').hidden = settings.tabPos === 'off';
}

$('btn-view').onclick = () => {
  settings.tabPos = TAB_CYCLE[settings.tabPos] || 'bottom';
  saveSettings();
  player?.setTabPos(settings.tabPos);
  updateViewButton();
};

function updateLoopUI(loop) {
  const info = $('loop-info');
  info.hidden = !loop;
  if (loop) {
    const pad = (n) => String(n).padStart(3, '0');
    $('loop-text').textContent =
      `Loop ${pad(loop.startNum)}–${pad(loop.endNum)}${loop.enabled ? '' : ' (off)'}`;
    info.classList.toggle('disabled', !loop.enabled);
  }
}

$('loop-text').onclick = () => player?.toggleLoop();
$('btn-loop-clear').onclick = () => player?.clearLoop();

$('btn-restart').onclick = () => {
  if (!player) return;
  player.seek(0);
  if (!player.playing) {
    player.play();
    el.btnPlay.textContent = 'Pause';
  }
};

el.seek.addEventListener('pointerdown', () => { seeking = true; });
el.seek.addEventListener('pointerup', () => { seeking = false; });
el.seek.addEventListener('change', () => {
  if (player) player.seek((el.seek.value / 1000) * player.duration);
  seeking = false;
});

// ---- shared setting setters (keep the bottom bar and the panel in sync) ----

const steppers = { scroll: [], playSpeed: [], offsetGlobal: [], offsetChart: [], tabZoom: [], syncCoarse: [], syncFine: [], feetRun: [] };
const volEls = { volMaster: [], volBgm: [], volNotes: [] }; // range inputs

function refreshSteppers(key) {
  steppers[key] = steppers[key].filter((s) => s.el.isConnected);
  for (const s of steppers[key]) s.refresh();
}

function setScrollSetting(v) {
  settings.scroll = v;
  saveSettings();
  if (player) player.speed = v;
  refreshSteppers('scroll');
}

// Applying play speed re-runs the time-stretcher, so debounce it: the value
// display updates per click, the audio switches shortly after the last one.
let playSpeedTimer = null;
let stretchJobs = 0;
function setPlaySpeedSetting(v) {
  settings.playSpeed = v;
  saveSettings();
  refreshSteppers('playSpeed');
  clearTimeout(playSpeedTimer);
  playSpeedTimer = setTimeout(applyPlaySpeedNow, 350);
}

async function applyPlaySpeedNow() {
  if (!player || Math.abs(player.playSpeed - settings.playSpeed) < 1e-9) return;
  const busy = player.needsStretch(settings.playSpeed);
  if (busy) {
    stretchJobs++;
    showOverlay('Time-stretching audio…');
  }
  await player.setPlaySpeed(settings.playSpeed);
  if (busy && --stretchJobs === 0) hideOverlay();
}

function setGlobalOffset(v) {
  settings.offsetMs = v;
  saveSettings();
  applyOffset();
  refreshSteppers('offsetGlobal');
}

function setChartOffset(v) {
  if (!currentChartKey) return;
  if (v === 0) delete chartOffsets[currentChartKey];
  else chartOffsets[currentChartKey] = v;
  localStorage.setItem(CHART_OFFSETS_KEY, JSON.stringify(chartOffsets));
  applyOffset();
  refreshSteppers('offsetChart');
}

function setTabZoomSetting(v) {
  settings.tabZoom = v;
  saveSettings();
  player?.setTabZoom(v);
  refreshSteppers('tabZoom');
}

const VOL_APPLY = {
  volMaster: (p, v) => p.setVolume(v),
  volBgm: (p, v) => p.setBgmVolume(v),
  volNotes: (p, v) => p.setNotesVolume(v),
};

function setVolumeSetting(key, v) {
  settings[key] = v;
  saveSettings();
  if (player) VOL_APPLY[key](player, v);
  volEls[key] = volEls[key].filter((n) => n.isConnected);
  for (const n of volEls[key]) n.value = v;
}

const fmtX = (v) => v.toFixed(2) + 'x';
const fmtMs = (v) => (v > 0 ? '+' : '') + v + ' ms';

const STEPPER_DEFS = {
  scroll: {
    min: 0.25, max: 10, step: 0.25, fmt: fmtX,
    get: () => settings.scroll, apply: setScrollSetting,
  },
  playSpeed: {
    min: 0.25, max: 2, step: 0.05, fmt: fmtX,
    get: () => settings.playSpeed, apply: setPlaySpeedSetting,
  },
  offsetGlobal: {
    min: -1000, max: 1000, step: 5, fmt: fmtMs,
    get: () => settings.offsetMs, apply: setGlobalOffset,
  },
  offsetChart: {
    min: -1000, max: 1000, step: 5, fmt: fmtMs,
    get: chartOffset, apply: setChartOffset,
    enabled: () => !!currentChartKey, // needs a loaded chart
  },
  tabZoom: {
    min: 0.25, max: 4, step: 0.25, fmt: fmtX,
    get: () => settings.tabZoom, apply: setTabZoomSetting,
  },
  // Two steps over the same value: coarse for long intros, fine for nudging.
  syncCoarse: {
    min: -60000, max: 60000, step: 100, fmt: fmtMs,
    get: () => syncShiftValue(), apply: setSyncShift,
    enabled: () => !!currentSync()?.audio,
  },
  syncFine: {
    min: -60000, max: 60000, step: 5, fmt: fmtMs,
    get: () => syncShiftValue(), apply: setSyncShift,
    enabled: () => !!currentSync()?.audio,
  },
  // Kicks at most this far apart form a run that alternates feet.
  feetRun: {
    min: 60, max: 250, step: 10, fmt: (v) => `${Math.round(v)} ms`,
    get: () => feetRunValue(), apply: setFeetRun,
    enabled: () => !!currentSync(),
  },
};

// A −/+ stepper with press-and-hold repeat; the value is also a text box
// that takes any number in range (not snapped to the step).
function makeStepper(key) {
  const { min, max, step, fmt, get, apply: applyValue, enabled } = STEPPER_DEFS[key];
  const decimals = STEPPER_DEFS[key].decimals ?? (step < 1 ? 2 : 0);

  const root = document.createElement('span');
  root.className = 'stepper';
  const mkBtn = (txt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = txt;
    return b;
  };
  const down = mkBtn('−');
  const up = mkBtn('+');
  const val = document.createElement('input');
  val.type = 'text';
  val.inputMode = decimals ? 'decimal' : 'numeric';
  val.className = 'stepper-val';
  val.autocomplete = 'off';
  val.spellcheck = false;

  const stepper = {
    el: root,
    refresh() {
      if (enabled && !enabled()) {
        val.value = '—';
        down.disabled = up.disabled = val.disabled = true;
        return;
      }
      val.disabled = false;
      const v = get();
      if (document.activeElement !== val) val.value = fmt(v);
      down.disabled = v <= min + 1e-9;
      up.disabled = v >= max - 1e-9;
    },
  };
  const bump = (d) => {
    if (enabled && !enabled()) return;
    let v = Math.round((get() + d * step) / step) * step;
    v = Math.max(min, Math.min(max, +v.toFixed(4)));
    if (v !== get()) applyValue(v);
  };
  // Typed entry: focus shows the bare number; Enter or leaving commits,
  // Escape reverts. Anything unparsable reverts too.
  val.addEventListener('focus', () => {
    val.value = String(+get().toFixed(decimals));
    val.select();
  });
  const commit = () => {
    const n = parseFloat(val.value.replace(/[x×\s]|ms/gi, '').replace(',', '.'));
    if (Number.isFinite(n) && !(enabled && !enabled())) {
      const v = Math.max(min, Math.min(max, +n.toFixed(decimals)));
      if (v !== get()) applyValue(v);
    }
    stepper.refresh();
  };
  val.addEventListener('blur', commit);
  val.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      val.blur(); // commits
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // don't close the panel / leave the player
      val.value = String(+get().toFixed(decimals));
      val.blur();
    }
  });

  for (const [btn, d] of [[down, -1], [up, 1]]) {
    let holdTimer = 0, repeatTimer = 0;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (document.activeElement === val) val.blur(); // commit typed text first
      bump(d);
      holdTimer = setTimeout(() => { repeatTimer = setInterval(() => bump(d), 80); }, 400);
    });
    const stop = () => { clearTimeout(holdTimer); clearInterval(repeatTimer); };
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
    // Keyboard activation (Enter/Space) arrives as a click with detail 0.
    btn.addEventListener('click', (e) => { if (e.detail === 0) bump(d); });
  }

  root.append(down, val, up);
  steppers[key].push(stepper);
  stepper.refresh();
  return stepper;
}

function initControlsFromSettings() {
  $('speed-stepper').append(makeStepper('scroll').el);
  $('playspeed-stepper').append(makeStepper('playSpeed').el);
  $('tabzoom-stepper').append(makeStepper('tabZoom').el);
  for (const [key, id] of [['volMaster', 'vol'], ['volBgm', 'vol-bgm'], ['volNotes', 'vol-notes']]) {
    const input = $(id);
    input.value = settings[key];
    input.oninput = () => setVolumeSetting(key, parseFloat(input.value));
    volEls[key].push(input);
  }
}

// ---- lane display panel ----

const lanePanel = $('lane-panel');

function applyLaneSettings() {
  if (!player) return;
  player.setColors(settings.colors);
  player.setDisplay(settings.display);
  player.setGroups(settings.groups);
  player.setHiddenLanes(settings.hiddenLanes);
  player.setLaneOrder(settings.laneOrder);
}

function buildLaneOrderList() {
  const ul = $('lane-order');
  ul.replaceChildren();
  settings.laneOrder.forEach((id, i) => {
    const li = document.createElement('li');
    const rule = GROUP_RULES[id];
    const merged = rule && settings.groups[rule[0]];
    const laneHidden = settings.hiddenLanes.includes(id);
    if (merged || laneHidden) li.classList.add('merged');

    const mv = document.createElement('span');
    mv.className = 'mv';
    for (const [txt, delta] of [['▲', -1], ['▼', 1]]) {
      const b = document.createElement('button');
      b.textContent = txt;
      b.disabled = i + delta < 0 || i + delta >= settings.laneOrder.length;
      b.onclick = () => {
        const o = settings.laneOrder;
        [o[i], o[i + delta]] = [o[i + delta], o[i]];
        saveSettings();
        applyLaneSettings();
        buildLaneOrderList();
      };
      mv.append(b);
    }

    const tag = document.createElement('span');
    tag.className = 'lane-tag';
    tag.textContent = id;
    tag.style.color = settings.colors[id];

    // Per-lane show/hide.
    const showLabel = document.createElement('label');
    showLabel.className = 'show-label';
    showLabel.title = 'Show or hide this lane (sound is unaffected)';
    const showCb = document.createElement('input');
    showCb.type = 'checkbox';
    showCb.checked = !laneHidden;
    showCb.onchange = () => {
      settings.hiddenLanes = showCb.checked
        ? settings.hiddenLanes.filter((h) => h !== id)
        : [...settings.hiddenLanes, id];
      saveSettings();
      applyLaneSettings();
      buildLaneOrderList();
    };
    showLabel.append(showCb, 'show');

    li.append(mv, tag, showLabel);

    if (rule) {
      const [key, target] = rule;
      const label = document.createElement('label');
      label.className = 'merge-label';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!settings.groups[key];
      cb.onchange = () => {
        settings.groups[key] = cb.checked;
        saveSettings();
        applyLaneSettings();
        buildLaneOrderList();
      };
      label.append(cb, `merge → ${target}`);
      li.append(label);
    }
    ul.append(li);
  });
}

function buildNoteColorList() {
  const wrap = $('note-colors');
  wrap.replaceChildren();
  for (const t of NOTE_TYPES) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'color';
    input.value = settings.colors[t.key];
    input.oninput = () => {
      settings.colors[t.key] = input.value;
      tag.style.color = input.value;
      saveSettings();
      player?.setColors(settings.colors);
      buildLaneOrderList(); // lane tags reflect colors
    };
    const tag = document.createElement('span');
    tag.className = 'type-tag';
    tag.textContent = t.key;
    tag.style.color = settings.colors[t.key];
    const name = document.createElement('span');
    name.className = 'type-name';
    name.textContent = t.label;
    label.append(input, tag, name);
    wrap.append(label);
  }
}

// DTXMania-style display options.
const DISPLAY_TOGGLES = [
  ['barLines', 'Bar lines'],
  ['beatLines', 'Beat lines'],
  ['measureNumbers', 'Measure numbers'],
  ['hitLine', 'Hit line'],
  ['laneFlash', 'Lane hit flash'],
  ['reverse', 'Reverse scroll'],
  ['sudden', 'Sudden (appear near line)'],
  ['hidden', 'Hidden (vanish near line)'],
];

function buildDisplayOpts() {
  const wrap = $('display-opts');
  wrap.replaceChildren();

  // Dark mode (OFF / HALF / FULL), like DTXMania's Dark setting.
  const darkLabel = document.createElement('label');
  darkLabel.className = 'display-row';
  const darkSel = document.createElement('select');
  for (const [val, txt] of [['off', 'OFF'], ['half', 'HALF (no lane frames)'], ['full', 'FULL (chips only)']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = txt;
    darkSel.append(opt);
  }
  darkSel.value = settings.display.dark;
  darkSel.onchange = () => {
    settings.display.dark = darkSel.value;
    saveSettings();
    player?.setDisplay(settings.display);
  };
  darkLabel.append('Dark', darkSel);
  wrap.append(darkLabel);

  for (const [key, text] of DISPLAY_TOGGLES) {
    const label = document.createElement('label');
    label.className = 'display-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!settings.display[key];
    cb.onchange = () => {
      settings.display[key] = cb.checked;
      saveSettings();
      player?.setDisplay(settings.display);
    };
    label.append(cb, text);
    wrap.append(label);
  }

  // Lane background opacity ("Lane Trans").
  const opLabel = document.createElement('label');
  opLabel.className = 'display-row';
  const op = document.createElement('input');
  op.type = 'range';
  op.min = '0';
  op.max = '100';
  op.step = '5';
  op.value = settings.display.laneOpacity;
  op.oninput = () => {
    settings.display.laneOpacity = parseInt(op.value, 10);
    saveSettings();
    player?.setDisplay(settings.display);
  };
  opLabel.append('Lane opacity', op);
  wrap.append(opLabel);
}

// DTXMania skin selector: imported skins reskin the play screen (notes, lane
// panels, hit bar, background, hit effects); "None" keeps procedural drawing.
async function buildSkinSection() {
  const wrap = $('skin-opts');
  wrap.replaceChildren();

  const skins = await listSkins();

  const selLabel = document.createElement('label');
  selLabel.className = 'display-row';
  const sel = document.createElement('select');
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'None (default flat style)';
  sel.append(none);
  for (const s of skins) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sel.append(opt);
  }
  sel.value = skins.some((s) => s.id === settings.skinId) ? settings.skinId : '';
  sel.onchange = () => {
    settings.skinId = sel.value || null;
    saveSettings();
    applySkin();
    del.disabled = !sel.value;
  };
  selLabel.append('Skin', sel);
  wrap.append(selLabel);

  const btns = document.createElement('div');
  btns.className = 'display-row';
  const imp = document.createElement('button');
  imp.className = 'btn small';
  imp.textContent = 'Import skin ZIP…';
  imp.title = 'A DTXMania skin: a ZIP containing a Graphics folder (7_chips_drums.png etc.)';
  imp.onclick = () => $('file-skin').click();
  const del = document.createElement('button');
  del.className = 'btn small';
  del.textContent = 'Delete';
  del.disabled = !sel.value;
  del.onclick = async () => {
    const id = sel.value;
    if (!id || !confirm('Delete this skin?')) return;
    await deleteSkin(id);
    if (settings.skinId === id) {
      settings.skinId = null;
      saveSettings();
      applySkin();
    }
    buildSkinSection();
  };
  btns.append(imp, del);
  wrap.append(btns);
}

async function importSkinZip(file) {
  try {
    showOverlay(`Extracting ${file.name}…`);
    const entries = await extractZip(file);
    const files = collectSkinFiles(entries);
    const skin = {
      id: newId(),
      name: file.name.replace(/\.zip$/i, ''),
      addedAt: Date.now(),
      size: files.reduce((a, f) => a + f.blob.size, 0),
      fileCount: files.length,
    };
    await addSkin(skin, files);
    settings.skinId = skin.id;
    saveSettings();
    applySkin();
    await buildSkinSection();
  } catch (err) {
    console.error(err);
    alert(`Failed to import skin:\n${err.message}`);
  }
  hideOverlay();
}

const fileSkin = $('file-skin');
fileSkin.onchange = () => {
  if (fileSkin.files[0]) importSkinZip(fileSkin.files[0]);
  fileSkin.value = '';
};

function buildPlaybackSection() {
  const wrap = $('playback-opts');
  wrap.replaceChildren();
  const row = (text, node) => {
    const r = document.createElement('span');
    r.className = 'display-row';
    r.append(text, node);
    wrap.append(r);
  };
  row('Scroll speed', makeStepper('scroll').el);
  row('Play speed', makeStepper('playSpeed').el);
  const g = makeStepper('offsetGlobal');
  g.el.title = 'Display-audio offset: positive shifts notes later, to compensate for audio output latency (real-time ms, independent of play speed)';
  row('Display offset', g.el);
  const c = makeStepper('offsetChart');
  c.el.title = 'Extra offset for the currently open chart, added on top of the global display offset (song-time ms, scales with play speed)';
  row('Chart offset', c.el);
  for (const [key, text] of [['volNotes', 'Notes volume'], ['volBgm', 'BGM volume'], ['volMaster', 'Master volume']]) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = settings[key];
    input.oninput = () => setVolumeSetting(key, parseFloat(input.value));
    volEls[key].push(input);
    row(text, input);
  }
}

// ---- recording sync (Guitar Pro charts) ----

const AUDIO_ACCEPT = 'audio/*,.ogg,.mp3,.wav,.m4a,.aac,.flac,.opus,.webm,.xa';
const modelCache = new Map(); // `${songId}::${path}` -> parsed model.json

function currentSync() {
  return current?.song.source === 'guitarpro' ? { ...NO_SYNC, ...current.song.sync } : null;
}

async function loadModel(song, path, fileMap) {
  const key = `${song.id}::${path}`;
  if (!modelCache.has(key)) {
    const blob = fileMap.get(path);
    if (!blob) throw new Error('This chart is missing its Guitar Pro model. Try re-importing the song.');
    modelCache.set(key, JSON.parse(await blob.text()));
  }
  return modelCache.get(key);
}

// Guitar Pro charts timed to a recording change tempo nearly every measure,
// so the chart viewer labels them with the score's tempos, and the BPM shown
// is the score's. Returns the BPM to display.
async function gpDisplayInfo(song, chartInfo, fileMap, dtx) {
  if (song.source !== 'guitarpro') return dtx.bpm;
  const nominal = chartInfo.bpm ?? dtx.bpm;
  const sync = { ...NO_SYNC, ...song.sync };
  if (!sync.audio || !chartInfo.model) return nominal;
  try {
    const model = await loadModel(song, chartInfo.model, fileMap);
    const lead = buildTimedChart(model, barTimesForSync(model, sync)).leadBars;
    const labels = new Map([[0, model.tempos[0].bpm]]);
    // Labels sit at measure starts; a mid-measure change shows on the next one.
    for (const t of model.tempos) labels.set(t.bar + lead + (t.tick === 0 ? 0 : 1), t.bpm);
    dtx.tempoLabels = labels;
  } catch (err) {
    console.warn('Tempo labels unavailable:', err);
  }
  return nominal;
}

function bgmTime(dtx) {
  return dtx?.chips.find((c) => c.ch === 0x01)?.time ?? 0;
}

// Sync changes are applied one at a time, in order.
let syncQueue = Promise.resolve();

// Regenerates a Guitar Pro song's charts for a sync state and stores them
// with the changed files. Updates fileMap; resolves to the updated song.
async function saveSongSync(song, fileMap, sync, putFiles = [], deletePaths = []) {
  for (const f of putFiles) fileMap.set(f.path, f.blob);
  for (const p of deletePaths) fileMap.delete(p);
  const charts = [];
  for (const d of song.dtxs) {
    const model = await loadModel(song, d.model, fileMap);
    charts.push({ path: d.path, origPath: d.path, blob: dtxBlob(gpChartText(model, sync, d.path)) });
  }
  for (const f of charts) fileMap.set(f.path, f.blob);
  const size = [...fileMap.values()].reduce((a, b) => a + b.size, 0);
  // Only sync and size change; the rest of the stored record (box, artist,
  // …) stays as it is now, not as it was when the chart was opened.
  const saved = await patchSong(song.id, (s) => { s.sync = sync; s.size = size; }, [...putFiles, ...charts], deletePaths);
  if (!saved) throw new Error('This song was deleted from the library.');
  return saved;
}

// Regenerates every chart of the open song for a new sync state, saves it,
// and reloads the open chart at the same point of the recording.
// patch: an object, or a (sync) => object | null function that runs in
// queue order, so it sees every earlier change (null = nothing to do).
function applySync(patch, { putFiles = [], deletePaths = [] } = {}) {
  syncQueue = syncQueue.then(async () => {
    if (!current || current.song.source !== 'guitarpro') return;
    const { song, chartInfo, fileMap } = current;
    if (typeof patch === 'function') {
      try {
        patch = await patch({ ...NO_SYNC, ...song.sync });
      } catch (err) {
        console.error(err);
        alert(err.message);
        return;
      }
      if (!patch) return;
    }
    const sync = { ...NO_SYNC, ...song.sync, ...patch };
    showOverlay('Updating chart…');
    try {
      const updated = await saveSongSync(song, fileMap, sync, putFiles, deletePaths);

      const wasPlaying = player?.playing;
      const audioPos = (player?.time ?? 0) - bgmTime(currentDtx);
      player?.pause();
      current = { song: updated, chartInfo, fileMap };
      const next = parseDTX(decodeText(await fileMap.get(chartInfo.path).arrayBuffer()));
      await openChart(updated, chartInfo, {
        fileMap, at: Math.max(0, audioPos + bgmTime(next)), autoplay: !!wasPlaying,
      });
      renderSongList();
    } catch (err) {
      console.error(err);
      hideOverlay();
      alert(`Could not update the chart:\n${err.message}`);
    }
    buildSyncSection();
  });
  return syncQueue;
}

let pendingShift = null;
let shiftTimer = null;

function syncShiftValue() {
  return pendingShift ?? currentSync()?.shiftMs ?? 0;
}

// The value updates per click; the chart regenerates after the last one.
function setSyncShift(v) {
  pendingShift = v;
  refreshSteppers('syncCoarse');
  refreshSteppers('syncFine');
  clearTimeout(shiftTimer);
  shiftTimer = setTimeout(() => {
    const shiftMs = pendingShift;
    applySync({ shiftMs }).then(() => { if (pendingShift === shiftMs) pendingShift = null; });
  }, 500);
}

function pickFile(accept) {
  return new Promise((resolve) => {
    // In the document while open: iOS Safari ignores clicks on detached inputs.
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;
    input.onchange = () => { resolve(input.files[0] || null); input.remove(); };
    input.addEventListener('cancel', () => { resolve(null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

async function attachRecording() {
  if (!current) return;
  const file = await pickFile(AUDIO_ACCEPT);
  if (!file) return;
  showOverlay(`Decoding ${file.name}…`);
  let buffer;
  try {
    // Decoding here also fills the decode cache for the reload below.
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    buffer = await new SoundBank(player?.ctx || new OAC(1, 1, 44100)).decode(file);
  } catch {
    hideOverlay();
    alert(`Could not decode ${file.name}. Try an OGG, MP3, WAV, M4A or XA file.`);
    return;
  }
  const path = normPath('audio/' + basename(file.name));
  const old = currentSync()?.audio?.path;
  pendingShift = null;
  await applySync(
    {
      audio: { path, name: file.name, size: file.size, duration: Math.round(buffer.duration * 1000) / 1000 },
      kit: false, // the recording already has the drums
      stems: null,
      ...NO_TIMING,
    },
    {
      putFiles: [{ path, origPath: file.name, blob: file }],
      deletePaths: [...(old && old !== path ? [old] : []), ...stemPaths(currentSync())],
    },
  );
}

function removeRecording() {
  const old = currentSync()?.audio?.path;
  if (!old) return;
  pendingShift = null;
  applySync({ audio: null, kit: true, stems: null, ...NO_TIMING }, { deletePaths: [old, ...stemPaths(currentSync())] });
}

// ---- drum separation (separate.js) ----

function stemPaths(sync) {
  return Object.values(sync?.stems?.files || {});
}

// Decodes the open song's drum stems and hands them to the player, which
// slices one keysound per drum note. missing / failed collect problems.
async function loadStemKeysounds(song, fileMap, dtx, missing, failed) {
  const sync = song.source === 'guitarpro' ? { ...NO_SYNC, ...song.sync } : null;
  if (!stemsInUse(sync)) {
    player.setStemKeysounds(null);
    return;
  }
  el.overlayText.textContent = 'Decoding drum stems…';
  const buffers = {};
  for (const [name, path] of Object.entries(sync.stems.files)) {
    if (name === 'nodrums') continue;
    const blob = fileMap.get(path);
    if (!blob) { missing.push(path); continue; }
    try { buffers[name] = await player.bank.decode(blob); } catch { failed.push(path); }
  }
  player.setStemKeysounds(buffers, bgmTime(dtx));
}

let separating = null; // { controller, progress, phase, songId, t0 } while running
let modelState = null; // listModels() result; null until first read
let modelTask = null;  // { controller, text } while a model installs

function modelsReady() {
  return !!(modelState?.drums && modelState?.drumsep);
}

async function refreshModels() {
  modelState = await listModels().catch(() => ({ drums: null, drumsep: null }));
  buildModelsSection();
  buildSyncSection();
}

async function separateDrums() {
  const sync = currentSync();
  if (!sync?.audio || separating) return;
  const { song, fileMap } = current;
  const controller = new AbortController();
  separating = { controller, progress: 0, phase: 'Starting', songId: song.id, t0: performance.now() };
  buildSyncSection();
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const buffer = await new SoundBank(player?.ctx || new OAC(1, 1, 44100)).decode(fileMap.get(sync.audio.path));
    const { separateRecording, STEM_DIR } = await import('./separate.js');
    const res = await separateRecording(buffer, {
      signal: controller.signal,
      onProgress: (p, phase, stats) => {
        if (!separating) return;
        separating.progress = p;
        if (phase) { separating.phase = phase; separating.stats = ''; }
        if (stats) separating.stats = stats;
        updateSeparateStatus();
      },
    });
    separating = null;
    const files = {};
    const putFiles = [];
    for (const [name, blob] of Object.entries(res.files)) {
      const path = STEM_DIR + name + (blob.type === 'audio/ogg' ? '.ogg' : '.flac');
      files[name] = path;
      putFiles.push({ path, origPath: path, blob });
    }
    const stems = {
      files,
      models: res.models,
      backend: res.backend,
      seconds: Math.round(res.seconds),
      bytes: putFiles.reduce((a, f) => a + f.blob.size, 0),
      at: Date.now(),
      use: true,
    };
    if (current?.song.id === song.id) {
      const old = stemPaths(currentSync()).filter((p) => !Object.values(files).includes(p));
      await applySync({ stems, kit: false }, { putFiles, deletePaths: old });
    } else {
      // Another song was opened meanwhile: store the result with its own song.
      const latest = (await listSongs()).find((s) => s.id === song.id);
      if (!latest) return;
      const synced = { ...NO_SYNC, ...latest.sync, stems, kit: false };
      const old = stemPaths(latest.sync).filter((p) => !Object.values(files).includes(p));
      await saveSongSync(latest, fileMap, synced, putFiles, old);
      renderSongList();
    }
  } catch (err) {
    separating = null;
    if (err.name !== 'AbortError') {
      console.error(err);
      alert(`Drum separation failed:\n${err.message}`);
    }
    buildSyncSection();
  }
}

function removeStems() {
  const paths = stemPaths(currentSync());
  if (!paths.length) return;
  applySync({ stems: null }, { deletePaths: paths });
}

function separateStatusText(sync) {
  if (separating && separating.songId === current?.song.id) {
    const { progress, phase, t0, stats } = separating;
    let text = `${phase}… ${Math.round(progress * 100)}%`;
    const elapsed = (performance.now() - t0) / 1000;
    if (progress > 0.03 && elapsed > 5) text += ` · about ${fmtTime((elapsed / progress) * (1 - progress) + 30)} left`;
    if (stats) text += ` · ${stats}`;
    return text;
  }
  const st = sync.stems;
  if (st) {
    const size = st.bytes ? `, ${fmtSize(st.bytes)}` : '';
    const how = `Separated with ${st.models.join(' + ')} (${st.backend}, ${fmtTime(st.seconds)}${size}).`;
    if (!st.use) return `${how} Off: the full recording plays.`;
    let text = `${how} The recording plays without its drums, and every drum note plays its own hit from it.`;
    if (!sync.barTimes && !sync.align) text += ' Align the chart first so each note finds its hit.';
    return text;
  }
  if (!modelState) return '';
  if (!modelsReady()) return 'Splits the recording into a drumless backing track and one keysound per drum note. Install the two separation models first (Separation models, below).';
  let text = 'Splits the recording into a drumless backing track and one keysound per drum note. Takes a few minutes.';
  if (!navigator.gpu) text += ' This browser has no WebGPU, so it runs on the CPU and is much slower.';
  return text;
}

function updateSeparateStatus() {
  const node = document.getElementById('sync-sep-status');
  const sync = currentSync();
  if (node && sync) node.textContent = separateStatusText(sync);
}

function pickFiles(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.hidden = true;
    input.onchange = () => { resolve([...input.files]); input.remove(); };
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

async function installModels(kind) {
  if (modelTask) return;
  let run;
  if (kind === 'files') {
    const files = await pickFiles('.onnx,.json');
    if (!files.length) return;
    run = (opts) => installFromFiles(files, opts);
  } else {
    const url = prompt('URL of a model’s .json manifest (its .onnx must sit next to it, and the server must allow CORS):');
    if (!url?.trim()) return;
    run = (opts) => installFromUrl(url.trim(), opts);
  }
  const controller = new AbortController();
  modelTask = { controller, text: 'Installing…' };
  buildModelsSection();
  try {
    await run({
      signal: controller.signal,
      onProgress: (p, m) => {
        if (!modelTask) return;
        modelTask.text = `Installing ${m.name}… ${Math.round(p * 100)}%`;
        const node = document.getElementById('model-status');
        if (node) node.textContent = modelTask.text;
      },
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      alert(`Model install failed:\n${err.message}`);
    }
  }
  modelTask = null;
  await refreshModels();
}

function buildModelsSection() {
  const wrap = $('model-opts');
  if (!wrap) return;
  wrap.replaceChildren();
  const note = (text) => {
    const p = document.createElement('p');
    p.className = 'panel-note';
    p.textContent = text;
    wrap.append(p);
    return p;
  };
  if (!opfsAvailable()) {
    note('This browser can’t store separation models.');
    return;
  }
  const row = (text, ...nodes) => {
    const r = document.createElement('span');
    r.className = 'display-row sync-recording';
    r.append(text, ...nodes);
    wrap.append(r);
    return r;
  };
  const button = (text, onclick, title = '') => {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = text;
    b.title = title;
    b.onclick = onclick;
    return b;
  };
  for (const [role, label] of Object.entries(ROLES)) {
    const m = modelState?.[role];
    const name = document.createElement('span');
    name.className = 'sync-file';
    name.textContent = modelState ? (m ? `${m.manifest.name} (${fmtSize(m.size)})` : 'Not installed') : '…';
    name.title = m ? `${m.manifest.stems.join(', ')} · ${m.manifest.sampleRate} Hz` : '';
    const actions = document.createElement('span');
    if (m && !modelTask) {
      actions.append(button('Remove', async () => {
        if (!confirm(`Remove the ${label.toLowerCase()} (${m.manifest.name})?`)) return;
        await removeModel(role);
        await refreshModels();
      }));
    }
    row(label, name, actions);
  }
  const actions = document.createElement('span');
  if (modelTask) {
    actions.append(button('Cancel', () => modelTask?.controller.abort()));
  } else {
    actions.append(
      button('Import files…', () => installModels('files'), 'Pick a model’s .onnx and .json files (both models at once is fine).'),
      button('From URL…', () => installModels('url'), 'Download a model from the URL of its .json manifest.'),
    );
  }
  row('Add', actions);
  const status = note(modelTask?.text || '');
  status.id = 'model-status';
  if (!modelTask) {
    note('Models made from Music-Source-Separation-Training checkpoints with tools/msst-onnx/export.py (see its README). ' +
      'They stay in this browser. ' + (navigator.gpu ? 'Runs on the GPU (WebGPU).' : 'No WebGPU here: separation runs on the CPU and is slow.'));
  }
  if (!modelState) refreshModels();
}


// ---- automatic alignment ----

let aligning = null; // { controller, progress, songId } while running

// All charts of a song share its measures; their notes together give the
// alignment the most to go on.
async function songAlignModel(song, fileMap) {
  const models = [];
  for (const d of song.dtxs) models.push(await loadModel(song, d.model, fileMap));
  const bars = models[0].bars.map((b, i) => ({ ticks: b.ticks, notes: models.flatMap((m) => m.bars[i]?.notes || []) }));
  return { ...models[0], bars };
}

async function autoAlign(pins = currentSync()?.pins || []) {
  const sync = currentSync();
  if (!sync?.audio || aligning) return;
  const { song, fileMap } = current;
  const controller = new AbortController();
  aligning = { controller, progress: 0, songId: song.id };
  buildSyncSection();
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const buffer = await new SoundBank(player?.ctx || new OAC(1, 1, 44100)).decode(fileMap.get(sync.audio.path));
    const model = await songAlignModel(song, fileMap);
    const { alignRecording } = await import('./align.js');
    const res = await alignRecording(buffer, model, {
      pins,
      signal: controller.signal,
      onProgress: (p) => { if (aligning) { aligning.progress = p; updateAlignStatus(); } },
    });
    aligning = null;
    if (current?.song.id !== song.id) return; // another song was opened meanwhile
    const uncertain = res.confidence.map((c, b) => (c !== null && c < 0.35 ? b : -1)).filter((b) => b >= 0);
    pendingShift = null;
    await applySync({
      barTimes: res.barTimes,
      shiftMs: 0,
      pins,
      align: { overall: res.overall, method: res.method, uncertain, at: Date.now() },
    });
  } catch (err) {
    aligning = null;
    if (err.name !== 'AbortError') {
      console.error(err);
      alert(`Auto-align failed:\n${err.message}`);
    }
    buildSyncSection();
  }
}

// Pins the measure nearest the playhead to this point of the recording (as
// heard, so minus the output latency the display offset compensates), then
// re-aligns. Pins are soft (±0.25 s), so tapping a little late is fine.
async function pinAtPlayhead() {
  const sync = currentSync();
  if (!sync?.audio || !player || aligning) return;
  const { song, chartInfo, fileMap } = current;
  const model = await loadModel(song, chartInfo.model, fileMap);
  const now = player.time - bgmTime(currentDtx) - (settings.offsetMs / 1000) * player.playSpeed;
  const times = barTimesForSync(model, sync);
  let bar = 0;
  for (let b = 1; b < model.bars.length; b++) if (Math.abs(times[b] - now) < Math.abs(times[bar] - now)) bar = b;
  // Keep the pins in order: drop any the new one contradicts.
  const pins = (sync.pins || []).filter((p) => p.bar !== bar && (p.bar < bar ? p.time < now : p.time > now));
  pins.push({ bar, time: now });
  pins.sort((a, b) => a.bar - b.bar);
  autoAlign(pins);
}

function leadBarsNow() {
  const sync = currentSync();
  const model = current && modelCache.get(`${current.song.id}::${current.chartInfo.model}`);
  if (!sync?.audio || !model) return 0;
  try { return buildTimedChart(model, barTimesForSync(model, sync)).leadBars; } catch { return 0; }
}

// Measure numbers as the player shows them (lead-in measures included).
function measureList(bars) {
  const lead = leadBarsNow();
  const nums = bars.map((b) => b + lead);
  const parts = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    const a = String(nums[i]).padStart(3, '0');
    parts.push(j > i ? `${a}–${String(nums[j]).padStart(3, '0')}` : a);
    i = j;
  }
  return parts.length > 6 ? parts.slice(0, 6).join(', ') + ', …' : parts.join(', ');
}

function alignStatusText(sync) {
  if (aligning && aligning.songId === current?.song.id) return `Aligning… ${Math.round(aligning.progress * 100)}%`;
  const a = sync.align;
  if (!a) return 'Not aligned yet. Auto-align times every measure to the recording.';
  const pct = Math.round(a.overall * 100);
  let text = `${a.method === 'constant' ? 'Steady tempo' : 'Follows the recording’s tempo'} · ${pct}% confident.`;
  if (a.overall < 0.5) text += ' This may be wrong: while it plays, press P at a few downbeats to pin them, which re-aligns.';
  else if (a.uncertain?.length) text += ` Uncertain: measure${a.uncertain.length > 1 ? 's' : ''} ${measureList(a.uncertain)}.`;
  if (sync.pins?.length) text += ` ${sync.pins.length} pinned.`;
  return text;
}

function updateAlignStatus() {
  const node = document.getElementById('sync-align-status');
  const sync = currentSync();
  if (node && sync) node.textContent = alignStatusText(sync);
}

function buildSyncSection() {
  buildFeetSection();
  const wrap = $('sync-opts');
  if (!wrap) return;
  wrap.replaceChildren();
  const sync = currentSync();
  if (!sync) {
    const p = document.createElement('p');
    p.className = 'panel-note';
    p.textContent = 'For charts imported from Guitar Pro files: open one to attach a recording of the song and time the chart to it.';
    wrap.append(p);
    return;
  }
  const row = (text, ...nodes) => {
    const r = document.createElement('span');
    r.className = 'display-row';
    r.append(text, ...nodes);
    wrap.append(r);
    return r;
  };
  const button = (text, onclick, title = '') => {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = text;
    b.title = title;
    b.onclick = onclick;
    return b;
  };

  const name = document.createElement('span');
  name.className = 'sync-file';
  name.textContent = sync.audio ? `${sync.audio.name} (${fmtTime(sync.audio.duration)})` : 'None';
  name.title = sync.audio?.name || '';
  const actions = document.createElement('span');
  actions.append(button(sync.audio ? 'Replace…' : 'Attach…', attachRecording, 'Pick an audio file of this song (OGG, MP3, WAV, M4A…). It is stored with the song in this browser.'));
  if (sync.audio) actions.append(button('Remove', removeRecording));
  row(name, actions).classList.add('sync-recording');

  const kit = document.createElement('input');
  kit.type = 'checkbox';
  kit.checked = sync.kit !== false;
  kit.onchange = () => applySync({ kit: kit.checked });
  const kitLabel = document.createElement('label');
  kitLabel.append(kit, ' Play drum kit');
  kitLabel.title = 'Play the built-in drum sounds for the chart’s notes. Off by default with a recording, since it already has the drums.';
  row('Drum sounds', kitLabel);

  if (sync.audio) {
    const coarse = makeStepper('syncCoarse');
    coarse.el.title = 'Move the chart against the recording: positive = notes later. 100 ms steps.';
    row('Shift chart', coarse.el);
    const fine = makeStepper('syncFine');
    fine.el.title = 'Fine shift, 5 ms steps.';
    row('Fine shift', fine.el);

    const running = aligning && aligning.songId === current.song.id;
    const alignActions = document.createElement('span');
    if (running) {
      alignActions.append(button('Cancel', () => aligning?.controller.abort()));
    } else {
      alignActions.append(button(sync.align ? 'Re-align' : 'Auto-align', () => autoAlign(),
        'Find where every measure falls in the recording, following its tempo changes.'));
      if (sync.barTimes || sync.pins?.length) {
        alignActions.append(button('Reset', () => applySync({ ...NO_TIMING }), 'Back to the score’s own tempo (clears the alignment, pins and shift).'));
      }
    }
    row('Timing', alignActions).classList.add('sync-recording');
    const status = document.createElement('span');
    status.id = 'sync-align-status';
    status.className = 'sync-status';
    status.textContent = alignStatusText(sync);
    wrap.append(status);

    if (!running) {
      const pinActions = document.createElement('span');
      pinActions.append(button('Pin (P)', pinAtPlayhead,
        'While the recording plays, press at a downbeat: the nearest measure is pinned there and the chart re-aligns. Shortcut: P.'));
      if (sync.pins?.length) pinActions.append(button('Clear', () => applySync({ pins: [] }), 'Forget the pinned measures (keeps the current timing).'));
      row('Pins', pinActions).classList.add('sync-recording');
    }

    const sepRunning = separating && separating.songId === current.song.id;
    const sepActions = document.createElement('span');
    if (sepRunning) {
      sepActions.append(button('Cancel', () => separating?.controller.abort()));
    } else if (sync.stems) {
      const use = document.createElement('input');
      use.type = 'checkbox';
      use.checked = !!sync.stems.use;
      use.onchange = () => {
        const on = use.checked;
        applySync((s) => (s.stems ? { stems: { ...s.stems, use: on }, kit: on ? false : s.kit } : null));
      };
      const useLabel = document.createElement('label');
      useLabel.append(use, ' Use');
      useLabel.title = 'Play the drumless backing track, with every drum note playing its own hit from the recording.';
      sepActions.append(useLabel, button('Remove', removeStems, 'Delete the separated stems of this song.'));
    } else {
      const b = button('Separate drums', separateDrums,
        'Split the recording into a drumless backing track and drum keysounds, in this browser.');
      b.disabled = !modelsReady() || !!separating;
      sepActions.append(b);
    }
    row('Drum stems', sepActions).classList.add('sync-recording');
    const sepStatus = document.createElement('span');
    sepStatus.id = 'sync-sep-status';
    sepStatus.className = 'sync-status';
    sepStatus.textContent = separateStatusText(sync);
    wrap.append(sepStatus);
    if (!modelState) refreshModels();
  }
}

// ---- foot edits (Guitar Pro charts) ----

let editingFeet = false; // session only: taps in the tab strip edit feet

function setEditingFeet(on) {
  editingFeet = on;
  if (player) player.editFeet = on && current?.song.source === 'guitarpro';
}

// A tapped kick switches feet; a tapped hi-hat or pedal note toggles the
// pedal at that point. Edits are stored only where they differ from what
// the rules would do on their own.
function editFoot(chip) {
  if (chip.m == null || !current) return;
  const path = current.chartInfo.path;
  applySync((sync) => (current.chartInfo.path === path ? footEditPatch(chip, sync) : null));
}

async function footEditPatch(chip, sync) {
  const { song, chartInfo, fileMap } = current;
  const model = await loadModel(song, chartInfo.model, fileMap);
  const lead = sync.audio ? buildTimedChart(model, barTimesForSync(model, sync)).leadBars : 0;
  const bar = chip.m - lead;
  if (!model.bars[bar]) return null;
  const tick = Math.round(chip.pos * model.bars[bar].ticks);

  const feet = feetOf(sync);
  const edits = { ...(feet.edits[chartInfo.path] || {}) };
  const notesAt = (m) => m.bars[bar].notes.filter((n) => n.tick === tick).map((n) => n.ch);
  let key, want, auto;
  if (chip.ch === CH_BD || chip.ch === CH_LBD) {
    key = kickKey(bar, tick);
    want = notesAt(assignFeet(model, feet, edits)).includes(CH_LBD) ? 'R' : 'L';
    delete edits[key];
    auto = notesAt(assignFeet(model, feet, edits)).includes(CH_LBD) ? 'L' : 'R';
  } else {
    key = pedalKey(bar, tick);
    want = notesAt(assignFeet(model, feet, edits)).includes(CH_LP) ? '-' : '+';
    delete edits[key];
    auto = notesAt(assignFeet(model, feet, edits)).includes(CH_LP) ? '+' : '-';
  }
  if (want !== auto) edits[key] = want;
  const all = { ...feet.edits, [chartInfo.path]: edits };
  if (!Object.keys(edits).length) delete all[chartInfo.path];
  return { feet: { ...feet, edits: all } };
}

function editCount(sync) {
  return Object.keys(feetOf(sync).edits[current?.chartInfo.path] || {}).length;
}

// Run-limit clicks update the value at once; the chart regenerates after
// the last one, like the sync shift.
let pendingRun = null;
let runTimer = null;

function feetRunValue() {
  return pendingRun ?? feetOf(currentSync()).runMs;
}

function setFeetRun(v) {
  pendingRun = v;
  refreshSteppers('feetRun');
  clearTimeout(runTimer);
  runTimer = setTimeout(() => {
    const runMs = pendingRun;
    applySync((s) => ({ feet: { ...feetOf(s), runMs } })).then(() => {
      if (pendingRun === runMs) pendingRun = null;
    });
  }, 500);
}

function buildFeetSection() {
  const wrap = $('feet-opts');
  if (!wrap) return;
  wrap.replaceChildren();
  const sync = currentSync();
  if (!sync) {
    const p = document.createElement('p');
    p.className = 'panel-note';
    p.textContent = 'For charts imported from Guitar Pro files: split fast kick runs between both feet and add hi-hat pedal closes.';
    wrap.append(p);
    return;
  }
  const row = (text, ...nodes) => {
    const r = document.createElement('span');
    r.className = 'display-row';
    r.append(text, ...nodes);
    wrap.append(r);
    return r;
  };
  const button = (text, onclick, title = '') => {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = text;
    b.title = title;
    b.onclick = onclick;
    return b;
  };
  const feet = feetOf(sync);
  const check = (text, key, title) => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!feet[key];
    input.onchange = () => {
      const on = input.checked;
      applySync((s) => ({ feet: { ...feetOf(s), [key]: on } }));
    };
    const label = document.createElement('label');
    label.append(input, ' ', text);
    label.title = title;
    return label;
  };
  row('Kicks', check('Split fast runs between both feet', 'kickSplit',
    'Kicks closer together than the run limit alternate right and left foot, by their place in the beat.'));
  row('Run limit', makeStepper('feetRun').el).title = 'Kicks at most this far apart count as one run.';
  row('Hi-hat', check('Close with the pedal', 'hhClose',
    'Adds a hi-hat pedal note where a closed hit follows an open hi-hat.'));

  const edit = document.createElement('input');
  edit.type = 'checkbox';
  edit.checked = editingFeet;
  edit.onchange = () => setEditingFeet(edit.checked);
  const editLabel = document.createElement('label');
  editLabel.append(edit, ' Edit in the tab strip');
  editLabel.title = 'While paused, tap a kick in the tab strip to switch feet, or a hi-hat note to add or remove the pedal. Needs the tab strip on.';
  const actions = document.createElement('span');
  actions.append(editLabel);
  const n = editCount(sync);
  if (n) {
    const path = current.chartInfo.path;
    actions.append(button(`Reset ${n} edit${n > 1 ? 's' : ''}`, () => applySync((s) => {
      const f = feetOf(s);
      const edits = { ...f.edits };
      delete edits[path];
      return { feet: { ...f, edits } };
    }), 'Forget the note edits on this chart.'));
  }
  row('Edits', actions).classList.add('sync-recording');
}

// ---- storage ----

let storageBusy = false;

async function buildStorageSection() {
  const wrap = $('storage-opts');
  if (!wrap) return;
  const row = (text, ...nodes) => {
    const r = document.createElement('span');
    r.className = 'display-row';
    r.append(text, ...nodes);
    return r;
  };
  const note = (text) => {
    const p = document.createElement('p');
    p.className = 'panel-note';
    p.textContent = text;
    return p;
  };

  const keep = document.createElement('input');
  keep.type = 'checkbox';
  keep.checked = !!settings.keepVideos;
  keep.onchange = () => { settings.keepVideos = keep.checked; saveSettings(); };
  const keepLabel = document.createElement('label');
  keepLabel.append(keep, ' Keep videos when importing');
  keepLabel.title = 'The player doesn\u2019t show background videos, so imports skip them to save space. '
    + 'Turn this on to store them anyway.';

  const usage = document.createElement('span');
  usage.textContent = '\u2026';
  const videos = document.createElement('span');
  videos.className = 'sync-recording';
  videos.textContent = '\u2026';
  wrap.replaceChildren(row('Used', usage), row('Videos', videos), row('Import', keepLabel));

  let estimate = null, persisted = null, meta = [];
  try { estimate = await navigator.storage?.estimate?.(); } catch { /* unavailable */ }
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* unavailable */ }
  try { meta = await listFileMeta(); } catch (err) { console.warn('storage listing failed', err); }

  const library = meta.reduce((a, f) => a + f.size, 0);
  usage.textContent = `Songs ${fmtSize(library)}` +
    (estimate?.quota ? ` \u00b7 this site ${fmtSize(estimate.usage || 0)} of ${fmtSize(estimate.quota)}` : '');
  if (persisted === false) {
    wrap.append(note('The browser may clear this library when the device runs low on space, or (Safari) after '
      + 'a week without visits. Installing the app to the Home Screen / Dock protects it.'));
  }

  const vids = meta.filter((f) => isVideoPath(f.path));
  const vidBytes = vids.reduce((a, f) => a + f.size, 0);
  videos.replaceChildren(vids.length
    ? `${vids.length} file${vids.length > 1 ? 's' : ''}, ${fmtSize(vidBytes)} `
    : 'None stored');
  if (!vids.length) return;
  const btn = document.createElement('button');
  btn.className = 'btn small';
  btn.textContent = 'Remove videos';
  btn.title = 'Delete the stored video files from every song. Charts and audio are kept.';
  btn.disabled = storageBusy;
  btn.onclick = async () => {
    if (!confirm(`Remove ${vids.length} video file${vids.length > 1 ? 's' : ''} (${fmtSize(vidBytes)}) from the library? `
      + 'Charts and audio stay; the videos aren\u2019t played anyway.')) return;
    storageBusy = true;
    btn.disabled = true;
    try {
      const bySong = new Map();
      for (const f of vids) {
        if (!bySong.has(f.songId)) bySong.set(f.songId, []);
        bySong.get(f.songId).push(f);
      }
      const songs = new Map((await listSongs()).map((s) => [s.id, s]));
      for (const [songId, files] of bySong) {
        if (!songs.has(songId)) continue; // orphaned files: leave them to deleteSong
        const freed = files.reduce((a, f) => a + f.size, 0);
        await patchSong(songId, (song) => { song.size = Math.max(0, (song.size || 0) - freed); }, [], files.map((f) => f.path));
      }
      alert(`Removed ${vids.length} video file${vids.length > 1 ? 's' : ''}, freeing ${fmtSize(vidBytes)}.`);
    } catch (err) {
      console.error(err);
      alert(`Failed to remove videos:\n${err.message}`);
    }
    storageBusy = false;
    await renderSongList();
    buildStorageSection();
  };
  videos.append(btn);
}

function openSettingsPanel() {
  buildPlaybackSection();
  buildSyncSection();
  buildModelsSection();
  buildLaneOrderList();
  buildNoteColorList();
  buildDisplayOpts();
  buildSkinSection();
  buildStorageSection();
  lanePanel.hidden = false;
}

$('btn-lanes').onclick = openSettingsPanel;
$('btn-settings').onclick = openSettingsPanel;
$('lane-panel-close').onclick = () => { lanePanel.hidden = true; };
lanePanel.addEventListener('click', (e) => {
  if (e.target === lanePanel) lanePanel.hidden = true;
});

$('lane-reset').onclick = () => {
  settings.laneOrder = [...LANE_IDS];
  settings.colors = defaultColors();
  settings.groups = { lc: false, lp: false, ft: false, rd: false };
  settings.display = defaultDisplay();
  settings.hiddenLanes = [];
  saveSettings();
  applyLaneSettings();
  buildLaneOrderList();
  buildNoteColorList();
  buildDisplayOpts();
};

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (openMenu) closeCardMenu();
    else if (!lanePanel.hidden) lanePanel.hidden = true;
    else if (!el.screenPlayer.hidden) backToSelect();
    return;
  }
  if (el.screenPlayer.hidden) {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || document.querySelector('dialog[open]') || !lanePanel.hidden;
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      $('lib-search').focus();
    }
    return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') {
    // preventDefault also cancels space-activation of a focused button,
    // so this always means play/pause and never re-clicks a toggle.
    e.preventDefault();
    $('btn-play').click();
  } else if (e.code === 'KeyP' && !e.metaKey && !e.ctrlKey && !e.altKey && currentSync()?.audio) {
    e.preventDefault();
    pinAtPlayhead();
  }
});

// ---- init ----

navigator.storage?.persist?.().catch(() => {});
// PWA app shell (HTTPS only, so serve.py development stays cache-free).
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
initControlsFromSettings();
updateViewButton();
renderSongList();
