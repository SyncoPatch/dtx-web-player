// IndexedDB persistence for imported songs and skins.
//
// Store "songs": { id, title, dtxs: [{ path, title, label, level, bpm, model? }], addedAt, size,
//                  source?: 'guitarpro', sync?: { audio, kit, shiftMs, barTimes } }
//                  box?: box id (absent/null = library root), folder?: import folder
// Store "files": { songId, path (normalized lowercase), origPath, blob }
//   plus one library record { songId: '#library', path: 'boxes.json', blob }
//   holding the box tree as JSON: [{ id, parent, title, genre, color,
//   comment, artist, folder, def }] (kept here to avoid a DB version bump;
//   older app versions never read songId '#library')
// Store "skins": { id, name, addedAt, size, fileCount }
// Store "skinFiles": { skinId, name (lowercased basename), blob }

const DB_NAME = 'dtx-web-player';
const DB_VERSION = 2;

let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        // Guard each create: this fires for v0->2 (fresh) and v1->2 (upgrade).
        const db = r.result;
        if (!db.objectStoreNames.contains('songs')) {
          db.createObjectStore('songs', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('files')) {
          const files = db.createObjectStore('files', { keyPath: ['songId', 'path'] });
          files.createIndex('songId', 'songId');
        }
        if (!db.objectStoreNames.contains('skins')) {
          db.createObjectStore('skins', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('skinFiles')) {
          const sf = db.createObjectStore('skinFiles', { keyPath: ['skinId', 'name'] });
          sf.createIndex('skinId', 'skinId');
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

export async function listSongs() {
  const db = await openDB();
  const songs = await req(db.transaction('songs').objectStore('songs').getAll());
  return songs.sort((a, b) => b.addedAt - a.addedAt);
}

export async function addSong(song, files) {
  const db = await openDB();
  const tx = db.transaction(['songs', 'files'], 'readwrite');
  tx.objectStore('songs').put(song);
  const fs = tx.objectStore('files');
  for (const f of files) fs.put({ songId: song.id, ...f });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Change a song as stored, in one transaction: change(song) edits the record
// read from the database (never a copy that may be outdated) and may return
// false to skip the write. Nothing happens if the song was deleted meanwhile.
// putFiles/deletePaths change some of its files in the same transaction.
export async function patchSong(id, change, putFiles = [], deletePaths = []) {
  const db = await openDB();
  const tx = db.transaction(['songs', 'files'], 'readwrite');
  const songs = tx.objectStore('songs');
  let result = null;
  songs.get(id).onsuccess = (e) => {
    const song = e.target.result;
    if (!song || change(song) === false) return;
    songs.put(song);
    const fs = tx.objectStore('files');
    for (const path of deletePaths) fs.delete([id, path]);
    for (const f of putFiles) fs.put({ songId: id, ...f });
    result = song;
  };
  await txDone(tx);
  return result;
}

export async function getSong(id) {
  const db = await openDB();
  return req(db.transaction('songs').objectStore('songs').get(id));
}

// ---- library boxes ----

export const LIBRARY_ID = '#library';
const BOXES_PATH = 'boxes.json';

function readBoxes(rec) {
  return rec?.blob ? rec.blob.text().then((t) => {
    try { const v = JSON.parse(t); return Array.isArray(v) ? v : []; } catch { return []; }
  }) : Promise.resolve([]);
}

export async function getBoxes() {
  const db = await openDB();
  const rec = await req(db.transaction('files').objectStore('files').get([LIBRARY_ID, BOXES_PATH]));
  return readBoxes(rec);
}

// Change the box list: change(boxes) edits the stored list in place (and may
// return false to skip). Blob reads can't happen inside an IndexedDB
// transaction, so this reads, then writes only if the record is unchanged
// since (retrying otherwise).
export async function updateBoxes(change) {
  const db = await openDB();
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await req(db.transaction('files').objectStore('files').get([LIBRARY_ID, BOXES_PATH]));
    const boxes = await readBoxes(before);
    if (change(boxes) === false) return boxes;
    const tx = db.transaction('files', 'readwrite');
    const fs = tx.objectStore('files');
    let conflict = false;
    fs.get([LIBRARY_ID, BOXES_PATH]).onsuccess = (e) => {
      const now = e.target.result;
      if ((now?.rev || 0) !== (before?.rev || 0)) { conflict = true; return; }
      fs.put({
        songId: LIBRARY_ID, path: BOXES_PATH, origPath: BOXES_PATH, rev: (before?.rev || 0) + 1,
        blob: new Blob([JSON.stringify(boxes)], { type: 'application/json' }),
      });
    };
    await txDone(tx);
    if (!conflict) return boxes;
  }
  throw new Error('The library was being changed elsewhere; try again.');
}

export async function getSongFiles(songId) {
  const db = await openDB();
  const idx = db.transaction('files').objectStore('files').index('songId');
  return req(idx.getAll(songId));
}

export async function deleteSong(songId) {
  const db = await openDB();
  const tx = db.transaction(['songs', 'files'], 'readwrite');
  tx.objectStore('songs').delete(songId);
  const idx = tx.objectStore('files').index('songId');
  idx.getAllKeys(songId).onsuccess = (e) => {
    for (const key of e.target.result) tx.objectStore('files').delete(key);
  };
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Every stored song file as { songId, path, size }, for storage accounting.
// Walks a cursor and reads only blob.size, never the file data.
export async function listFileMeta() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = [];
    const r = db.transaction('files').objectStore('files').openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) { resolve(out); return; }
      const v = c.value;
      if (v.songId !== LIBRARY_ID) out.push({ songId: v.songId, path: v.path, size: v.blob?.size || 0 });
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
}

// ---- skins ----

export async function listSkins() {
  const db = await openDB();
  const skins = await req(db.transaction('skins').objectStore('skins').getAll());
  return skins.sort((a, b) => b.addedAt - a.addedAt);
}

export async function addSkin(skin, files) {
  const db = await openDB();
  const tx = db.transaction(['skins', 'skinFiles'], 'readwrite');
  tx.objectStore('skins').put(skin);
  const fs = tx.objectStore('skinFiles');
  for (const f of files) fs.put({ skinId: skin.id, ...f });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getSkinFiles(skinId) {
  const db = await openDB();
  const idx = db.transaction('skinFiles').objectStore('skinFiles').index('skinId');
  return req(idx.getAll(skinId));
}

export async function deleteSkin(skinId) {
  const db = await openDB();
  const tx = db.transaction(['skins', 'skinFiles'], 'readwrite');
  tx.objectStore('skins').delete(skinId);
  const idx = tx.objectStore('skinFiles').index('skinId');
  idx.getAllKeys(skinId).onsuccess = (e) => {
    for (const key of e.target.result) tx.objectStore('skinFiles').delete(key);
  };
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
