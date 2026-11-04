// App wiring: import (ZIP / folder), persisted song list, playback screen.

import { extractZip } from './zip.js';
import { parseDTX, parseSetDef, decodeText } from './dtx.js';
import { listSongs, addSong, updateSong, deleteSong, getSongFiles, listSkins, addSkin, deleteSkin } from './db.js';
import { Player, NOTE_TYPES, LANE_IDS, GROUP_RULES, defaultColors, defaultDisplay } from './player.js';
import { Skin, collectSkinFiles } from './skin.js';
import { isGuitarProFile, convertGuitarPro } from './gp.js'; // alphaTab itself loads lazily
import { writeDtx } from './dtxwrite.js';
import { renderDrumKit, KIT_FILES } from './drumkit.js';
import { buildTimedChart, barTimesForSync } from './gpsync.js';
import { SoundBank } from './audio.js';

const $ = (id) => document.getElementById(id);

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
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

// Normalize an archive path: backslashes to slashes, resolve ./ and ../,
// lowercase (DTX files come from case-insensitive filesystems).
function normPath(p) {
  const parts = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/').toLowerCase();
}

function dirname(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function basename(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

function stripExt(p) {
  const i = p.lastIndexOf('.');
  return i < 0 ? p : p.slice(0, i);
}

// Resolve a WAV reference relative to the chart's directory, with fallbacks:
// alternate audio extensions (DTXMania does this too — charts often say .wav
// or .xa while the package ships .ogg, or vice versa), then a basename search anywhere in
// the archive.
const AUDIO_EXTS = ['.ogg', '.wav', '.mp3', '.m4a', '.flac', '.aac', '.opus', '.webm', '.xa'];

function makeResolver(fileMap, baseDir) {
  return (ref) => {
    const rel = normPath(ref);
    const p = baseDir ? normPath(baseDir + '/' + rel) : rel;
    for (const cand of [p, rel]) {
      if (fileMap.has(cand)) return fileMap.get(cand);
      const stem = stripExt(cand);
      for (const ext of AUDIO_EXTS) {
        if (fileMap.has(stem + ext)) return fileMap.get(stem + ext);
      }
    }
    const wantBase = stripExt(basename(p));
    for (const [k, v] of fileMap) {
      const kb = basename(k);
      if (stripExt(kb) === wantBase && AUDIO_EXTS.includes(kb.slice(stripExt(kb).length))) return v;
    }
    return null;
  };
}

// ---- import ----

// entries: [{ path (original, /-separated), data: Blob }]
async function importEntries(fallbackTitle, totalSize, entries) {
  const files = [];
  for (const e of entries) {
    const path = e.path.replace(/\\/g, '/');
    if (path.includes('__MACOSX/') || basename(path).startsWith('._')) continue;
    files.push({ path: normPath(path), origPath: path, blob: e.blob });
  }

  const dtxFiles = files.filter((f) => f.path.endsWith('.dtx'));
  if (!dtxFiles.length) throw new Error('No .dtx files found in the import.');

  // Read chart headers for titles/levels.
  const dtxs = [];
  for (const f of dtxFiles) {
    let h = { title: '', level: null, bpm: null };
    try {
      h = parseDTX(decodeText(await f.blob.arrayBuffer()), { headersOnly: true });
    } catch { /* keep placeholder */ }
    dtxs.push({
      path: f.path,
      title: h.title || basename(f.origPath),
      label: '',
      level: h.level,
      bpm: h.bpm,
    });
  }

  // SET.def, when present, provides the song title and difficulty labels.
  let songTitle = null;
  const setDef = files.find((f) => basename(f.path) === 'set.def');
  if (setDef) {
    try {
      const def = parseSetDef(decodeText(await setDef.blob.arrayBuffer()));
      songTitle = def.title;
      const dir = dirname(setDef.path);
      for (const c of def.charts) {
        const target = dir ? normPath(dir + '/' + c.file) : normPath(c.file);
        const match = dtxs.find((d) => d.path === target || basename(d.path) === normPath(c.file));
        if (match) match.label = c.label;
      }
    } catch { /* SET.def is optional */ }
  }

  dtxs.sort((a, b) => (a.level ?? 999) - (b.level ?? 999));

  const song = {
    id: crypto.randomUUID(),
    title: songTitle || dtxs[0].title || fallbackTitle,
    dtxs,
    addedAt: Date.now(),
    size: totalSize,
  };
  await addSong(song, files);
  return song;
}

// Guitar Pro: each drum track becomes a generated .dtx chart played with a
// synthesized kit. The original file and a beat-domain model are stored too,
// so charts can be regenerated (e.g. re-timed to a recording) later.
// audio: the attached recording; barTimes: an alignment's measure starts
// (audio seconds); align: its summary; pins: [{ bar, time }] marked by ear.
const NO_SYNC = { audio: null, kit: true, shiftMs: 0, barTimes: null, align: null, pins: [] };
const NO_TIMING = { shiftMs: 0, barTimes: null, align: null, pins: [] };

// DTX text for a Guitar Pro chart under a song's sync state: the score's own
// timing with no recording, else timed to the recording placed as BGM.
function gpChartText(model, sync = NO_SYNC) {
  const kitVolume = sync.kit === false ? 0 : 100;
  if (!sync.audio) return writeDtx(model, model.tempos, { wavs: KIT_FILES, kitVolume });
  const timed = buildTimedChart(model, barTimesForSync(model, sync));
  return writeDtx(timed.model, timed.tempos, {
    wavs: KIT_FILES, kitVolume, bgm: { file: sync.audio.path, ...timed.bgm },
  });
}

function dtxBlob(text) {
  return new Blob(['﻿' + text], { type: 'text/plain' });
}

async function importGuitarPro(file) {
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
    files.push({ path: stem + '.dtx', origPath: stem + '.dtx', blob: dtxBlob(gpChartText(chart.model)) });
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
    id: crypto.randomUUID(),
    title: gp.title || file.name.replace(/\.[^.]+$/, ''),
    dtxs,
    addedAt: Date.now(),
    size: files.reduce((a, f) => a + f.blob.size, 0),
    source: 'guitarpro',
    sync: { ...NO_SYNC },
  };
  await addSong(song, files);
  return warnings;
}

async function importZipFiles(fileList) {
  for (const file of fileList) {
    if (isGuitarProFile(file.name)) {
      try {
        const warnings = await importGuitarPro(file);
        if (warnings.length) alert(`Imported ${file.name} with warnings:\n\n${warnings.join('\n')}`);
      } catch (err) {
        console.error(err);
        alert(`Failed to import ${file.name}:\n${err.message}`);
      }
      continue;
    }
    try {
      showOverlay(`Extracting ${file.name}…`);
      const entries = await extractZip(await file.arrayBuffer());
      showOverlay(`Importing ${file.name}…`);
      await importEntries(
        file.name.replace(/\.zip$/i, ''),
        file.size,
        entries.map((e) => ({ path: e.name, blob: new Blob([e.data]) })),
      );
    } catch (err) {
      console.error(err);
      alert(`Failed to import ${file.name}:\n${err.message}`);
    }
  }
  hideOverlay();
  await renderSongList();
}

async function importFromUrl() {
  const url = (prompt('URL of a ZIP containing .dtx charts and audio:') || '').trim();
  if (!url) return;
  try {
    showOverlay('Downloading…');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

    let buf;
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
      buf = await new Blob(parts).arrayBuffer();
    } else {
      buf = await resp.arrayBuffer();
    }

    const name = decodeURIComponent(
      new URL(url, location.href).pathname.split('/').pop() || 'download.zip',
    );
    showOverlay(`Extracting ${name}…`);
    const entries = await extractZip(buf);
    showOverlay(`Importing ${name}…`);
    await importEntries(
      name.replace(/\.zip$/i, ''),
      buf.byteLength,
      entries.map((e) => ({ path: e.name, blob: new Blob([e.data]) })),
    );
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
    const size = files.reduce((a, f) => a + f.size, 0);
    await importEntries(
      root,
      size,
      files.map((f) => ({ path: f.webkitRelativePath || f.name, blob: f })),
    );
  } catch (err) {
    console.error(err);
    alert(`Failed to import folder:\n${err.message}`);
  }
  hideOverlay();
  await renderSongList();
}

// ---- song list ----

async function renderSongList() {
  const songs = await listSongs();
  el.songList.replaceChildren();
  el.emptyHint.hidden = songs.length > 0;

  for (const song of songs) {
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
    del.onclick = async () => {
      if (!confirm(`Delete "${song.title}" from this browser?`)) return;
      await deleteSong(song.id);
      let pruned = false;
      for (const key of Object.keys(chartOffsets)) {
        if (key.startsWith(song.id + '::')) { delete chartOffsets[key]; pruned = true; }
      }
      if (pruned) localStorage.setItem(CHART_OFFSETS_KEY, JSON.stringify(chartOffsets));
      renderSongList();
    };
    head.append(title, menuBtn, del);

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
      btn.onclick = () => openChart(song, d);
      charts.append(btn);
    }

    li.append(head, meta, charts);
    el.songList.append(li);
  }
}

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
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 250))}px`;
  document.body.append(menu);
  openMenu = menu;
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

const steppers = { scroll: [], playSpeed: [], offsetGlobal: [], offsetChart: [], tabZoom: [], syncCoarse: [], syncFine: [] };
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
};

// A −/+ stepper with press-and-hold repeat.
function makeStepper(key) {
  const { min, max, step, fmt, get, apply: applyValue, enabled } = STEPPER_DEFS[key];

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
  const val = document.createElement('span');
  val.className = 'stepper-val';

  const stepper = {
    el: root,
    refresh() {
      if (enabled && !enabled()) {
        val.textContent = '—';
        down.disabled = up.disabled = true;
        return;
      }
      const v = get();
      val.textContent = fmt(v);
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
  for (const [btn, d] of [[down, -1], [up, 1]]) {
    let holdTimer = 0, repeatTimer = 0;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
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
    const entries = await extractZip(await file.arrayBuffer());
    const files = collectSkinFiles(entries);
    const skin = {
      id: crypto.randomUUID(),
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

// Regenerates every chart of the open song for a new sync state, saves it,
// and reloads the open chart at the same point of the recording.
function applySync(patch, { putFiles = [], deletePaths = [] } = {}) {
  syncQueue = syncQueue.then(async () => {
    if (!current || current.song.source !== 'guitarpro') return;
    const { song, chartInfo, fileMap } = current;
    const sync = { ...NO_SYNC, ...song.sync, ...patch };
    showOverlay('Updating chart…');
    try {
      for (const f of putFiles) fileMap.set(f.path, f.blob);
      for (const p of deletePaths) fileMap.delete(p);
      const charts = [];
      for (const d of song.dtxs) {
        const model = await loadModel(song, d.model, fileMap);
        charts.push({ path: d.path, origPath: d.path, blob: dtxBlob(gpChartText(model, sync)) });
      }
      for (const f of charts) fileMap.set(f.path, f.blob);
      const updated = { ...song, sync, size: [...fileMap.values()].reduce((a, b) => a + b.size, 0) };
      await updateSong(updated, [...putFiles, ...charts], deletePaths);

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
      ...NO_TIMING,
    },
    { putFiles: [{ path, origPath: file.name, blob: file }], deletePaths: old && old !== path ? [old] : [] },
  );
}

function removeRecording() {
  const old = currentSync()?.audio?.path;
  if (!old) return;
  pendingShift = null;
  applySync({ audio: null, kit: true, ...NO_TIMING }, { deletePaths: [old] });
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
  }
}

function openSettingsPanel() {
  buildPlaybackSection();
  buildSyncSection();
  buildLaneOrderList();
  buildNoteColorList();
  buildDisplayOpts();
  buildSkinSection();
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
  if (el.screenPlayer.hidden) return;
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
