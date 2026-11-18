// IndexedDB persistence for imported songs and skins.
//
// Store "songs": { id, title, dtxs: [{ path, title, label, level, bpm, model? }], addedAt, size,
//                  source?: 'guitarpro', sync?: { audio, kit, shiftMs, barTimes } }
// Store "files": { songId, path (normalized lowercase), origPath, blob }
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

// Change a song record and some of its files in one transaction. change()
// gets the record as currently stored, so a caller holding an older copy
// can't revert fields it doesn't own (e.g. the artist backfill once wrote
// back a snapshot that predated an attached recording). If the song was
// deleted meanwhile nothing is written and the result is null; otherwise
// it is the stored record.
export async function patchSong(id, change, putFiles = [], deletePaths = []) {
  const db = await openDB();
  const tx = db.transaction(['songs', 'files'], 'readwrite');
  const songs = tx.objectStore('songs');
  let result = null;
  const r = songs.get(id);
  r.onsuccess = () => {
    if (!r.result) return; // deleted: write nothing
    result = change(r.result);
    songs.put(result);
    const fs = tx.objectStore('files');
    for (const path of deletePaths) fs.delete([id, path]);
    for (const f of putFiles) fs.put({ songId: id, ...f });
  };
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Replace a song record and change some of its files in one transaction.
// Prefer patchSong: this overwrites every field with the given copy.
export async function updateSong(song, putFiles = [], deletePaths = []) {
  const db = await openDB();
  const tx = db.transaction(['songs', 'files'], 'readwrite');
  tx.objectStore('songs').put(song);
  const fs = tx.objectStore('files');
  for (const path of deletePaths) fs.delete([song.id, path]);
  for (const f of putFiles) fs.put({ songId: song.id, ...f });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getSong(id) {
  const db = await openDB();
  return (await req(db.transaction('songs').objectStore('songs').get(id))) ?? null;
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
      out.push({ songId: v.songId, path: v.path, size: v.blob?.size || 0 });
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
