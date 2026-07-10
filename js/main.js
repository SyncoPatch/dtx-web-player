// App wiring: import (ZIP / folder), persisted song list, playback screen.

import { extractZip } from './zip.js';
import { parseDTX, parseSetDef, decodeText } from './dtx.js';
import { listSongs, addSong, deleteSong, getSongFiles } from './db.js';
import { Player, NOTE_TYPES, LANE_IDS, GROUP_RULES, defaultColors, defaultDisplay } from './player.js';

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
  player?.setOffset((settings.offsetMs + chartOffset()) / 1000);
}

function applySettings(p) {
  p.speed = settings.scroll;
  p.setTabPos(settings.tabPos);
  p.setTabZoom(settings.tabZoom);
  p.setOffset((settings.offsetMs + chartOffset()) / 1000);
  p.setPlaySpeed(settings.playSpeed);
  p.setVolume(settings.volMaster);
  p.setBgmVolume(settings.volBgm);
  p.setNotesVolume(settings.volNotes);
  p.setColors(settings.colors);
  p.setDisplay(settings.display);
  p.setGroups(settings.groups);       // rebuilds lanes,
  p.setHiddenLanes(settings.hiddenLanes);
  p.setLaneOrder(settings.laneOrder); // so order last
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
// or .xa while the package ships .ogg), then a basename search anywhere in
// the archive.
const AUDIO_EXTS = ['.ogg', '.wav', '.mp3', '.m4a', '.flac', '.aac', '.opus', '.webm'];

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

async function importZipFiles(fileList) {
  for (const file of fileList) {
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
    head.append(title, del);

    const meta = document.createElement('div');
    meta.className = 'song-meta';
    meta.textContent = `${song.dtxs.length} chart${song.dtxs.length > 1 ? 's' : ''} · ${fmtSize(song.size)} · added ${new Date(song.addedAt).toLocaleDateString()}`;

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

// ---- playback ----

async function openChart(song, chartInfo) {
  try {
    showOverlay('Loading files…');
    const stored = await getSongFiles(song.id);
    const fileMap = new Map(stored.map((f) => [f.path, f.blob]));

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

    currentChartKey = `${song.id}::${chartInfo.path}`;
    applyOffset();
    refreshSteppers('offsetChart');

    const resolve = makeResolver(fileMap, dirname(chartInfo.path));
    const { missing, failed } = await player.load(dtx, resolve, (done, total) => {
      el.overlayText.textContent = `Decoding audio ${done} / ${total}…`;
    });

    el.npTitle.textContent = dtx.title || song.title;
    const sub = [];
    if (dtx.artist) sub.push(dtx.artist);
    sub.push(`BPM ${dtx.bpm}`);
    if (chartInfo.label) sub.push(chartInfo.label);
    const lvl = fmtLevel(dtx.level);
    if (lvl) sub.push(`Lv ${lvl}`);
    el.npSub.textContent = sub.join(' · ');

    currentDtx = dtx;
    currentMeta = {
      title: dtx.title || song.title,
      artist: dtx.artist,
      bpm: dtx.bpm,
      level: lvl,
      label: chartInfo.label,
    };

    const problems = missing.length + failed.length;
    if (problems) {
      el.npWarn.textContent = `⚠ ${problems} sound${problems > 1 ? 's' : ''} unavailable`;
      el.npWarn.title =
        (missing.length ? `Missing files:\n${missing.join('\n')}\n` : '') +
        (failed.length ? `Could not decode (unsupported format, e.g. .xa/.wma):\n${failed.join('\n')}` : '');
    } else {
      el.npWarn.textContent = '';
      el.npWarn.title = '';
    }

    el.timeTotal.textContent = fmtTime(player.duration);
    el.screenSelect.hidden = true;
    el.screenPlayer.hidden = false;
    hideOverlay();

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

$('btn-pdf').onclick = async () => {
  if (!currentDtx) return;
  try {
    showOverlay('Generating PDF…');
    const { buildScorePdf } = await import('./score.js');
    const bytes = await buildScorePdf({
      title: currentMeta.title,
      artist: currentMeta.artist,
      bpm: currentMeta.bpm,
      level: currentMeta.level,
      chips: currentDtx.chips,
      bars: currentDtx.bars,
      beats: currentDtx.beats,
    }, { textToImage });
    const name = `${currentMeta.title}${currentMeta.label ? ` (${currentMeta.label})` : ''}`
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

const steppers = { scroll: [], playSpeed: [], offsetGlobal: [], offsetChart: [], tabZoom: [] };
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
  g.el.title = 'Display-audio offset: positive shifts notes later, to compensate for audio output latency';
  row('Display offset', g.el);
  const c = makeStepper('offsetChart');
  c.el.title = 'Extra offset for the currently open chart, added on top of the global display offset';
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

function openSettingsPanel() {
  buildPlaybackSection();
  buildLaneOrderList();
  buildNoteColorList();
  buildDisplayOpts();
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
    if (!lanePanel.hidden) lanePanel.hidden = true;
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
