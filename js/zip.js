// Minimal ZIP extractor built on the browser's native DecompressionStream.
// Supports stored (0) and deflate (8) entries, Shift-JIS or UTF-8 file names,
// and Zip64. Encrypted archives are rejected.
//
// Reads lazily from a Blob/File: only the central directory and the small
// local headers are read up front. Stored entries come back as zero-copy
// slices of the source, deflated ones are inflated one at a time, and
// skipped entries are never read. So a multi-GB package (or one full of
// videos) never has to fit in memory at once.

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const utf8 = new TextDecoder('utf-8');

function decodeName(bytes, isUtf8) {
  if (!isUtf8) {
    // Zips made on Japanese Windows almost always use Shift-JIS names.
    try { return new TextDecoder('shift_jis', { fatal: true }).decode(bytes); }
    catch { /* fall through */ }
  }
  return utf8.decode(bytes);
}

async function readRange(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function inflateRaw(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).blob();
}

// source: Blob/File (preferred) or ArrayBuffer/Uint8Array.
// opts.skip(name) -> true leaves an entry unread; it is listed in .skipped.
// Returns [{ name, blob }] for every regular file, with
// .skipped = [{ name, size }] (size uncompressed) attached to the array.
export async function extractZip(source, { skip = null } = {}) {
  const blob = source instanceof Blob ? source : new Blob([source]);
  const len = blob.size;

  // Locate the end-of-central-directory record (scan back past any comment).
  const tailStart = Math.max(0, len - 22 - 65535 - 20);
  const tail = await readRange(blob, tailStart, len);
  const tdv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tdv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (end-of-central-directory not found)');

  let count = tdv.getUint16(eocd + 10, true);
  let cdSize = tdv.getUint32(eocd + 12, true);
  let cdOff = tdv.getUint32(eocd + 16, true);

  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
    const loc = eocd - 20;
    if (loc >= 0 && tdv.getUint32(loc, true) === SIG_EOCD64_LOC) {
      const z64 = Number(tdv.getBigUint64(loc + 8, true));
      const rec = await readRange(blob, z64, z64 + 56);
      const rdv = new DataView(rec.buffer);
      if (rec.length === 56 && rdv.getUint32(0, true) === SIG_EOCD64) {
        count = Number(rdv.getBigUint64(32, true));
        cdSize = Number(rdv.getBigUint64(40, true));
        cdOff = Number(rdv.getBigUint64(48, true));
      }
    }
  }

  // Walk the central directory.
  const cd = await readRange(blob, cdOff, Math.min(len, cdOff + cdSize));
  const dv = new DataView(cd.buffer);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (dv.getUint32(p, true) !== SIG_CENTRAL) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let compSize = dv.getUint32(p + 20, true);
    let uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let localOff = dv.getUint32(p + 42, true);
    const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);

    if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF || localOff === 0xFFFFFFFF) {
      let ep = p + 46 + nameLen;
      const eend = ep + extraLen;
      while (ep + 4 <= eend) {
        const id = dv.getUint16(ep, true);
        const sz = dv.getUint16(ep + 2, true);
        if (id === 0x0001) {
          let fp = ep + 4;
          if (uncompSize === 0xFFFFFFFF) { uncompSize = Number(dv.getBigUint64(fp, true)); fp += 8; }
          if (compSize === 0xFFFFFFFF) { compSize = Number(dv.getBigUint64(fp, true)); fp += 8; }
          if (localOff === 0xFFFFFFFF) { localOff = Number(dv.getBigUint64(fp, true)); fp += 8; }
        }
        ep += 4 + sz;
      }
    }

    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry
    if (flags & 0x1) throw new Error(`"${name}" is encrypted — password-protected ZIPs are not supported`);
    entries.push({ name, method, compSize, uncompSize, localOff });
  }

  // Extract file data via the local headers (whose name/extra lengths can
  // differ from the central directory's).
  const out = [];
  out.skipped = [];
  for (const e of entries) {
    if (skip?.(e.name)) { out.skipped.push({ name: e.name, size: e.uncompSize }); continue; }
    const q = e.localOff;
    if (q + 30 > len) continue;
    const lh = await readRange(blob, q, q + 30);
    const ldv = new DataView(lh.buffer);
    if (ldv.getUint32(0, true) !== SIG_LOCAL) continue;
    const start = q + 30 + ldv.getUint16(26, true) + ldv.getUint16(28, true);
    const comp = blob.slice(start, start + e.compSize);
    let data;
    if (e.method === 0) data = comp;
    else if (e.method === 8) data = await inflateRaw(comp);
    else continue; // unsupported compression method
    out.push({ name: e.name, blob: data });
  }
  return out;
}
