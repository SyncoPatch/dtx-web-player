// IndexedDB persistence for imported songs.
//
// Store "songs": { id, title, dtxs: [{ path, title, label, level, bpm }], addedAt, size }
// Store "files": { songId, path (normalized lowercase), origPath, blob }

const DB_NAME = 'dtx-web-player';
const DB_VERSION = 1;

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
        const db = r.result;
        db.createObjectStore('songs', { keyPath: 'id' });
        const files = db.createObjectStore('files', { keyPath: ['songId', 'path'] });
        files.createIndex('songId', 'songId');
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
