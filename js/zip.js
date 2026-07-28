// Minimal ZIP extractor built on the browser's native DecompressionStream.
// Supports stored (0) and deflate (8) entries, Shift-JIS or UTF-8 file names,
// and basic Zip64 offsets. Encrypted archives are rejected.

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

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Returns [{ name, data: Uint8Array }] for every regular file in the archive.
export async function extractZip(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  const len = u8.length;

  // Locate the end-of-central-directory record (scan back past any comment).
  let eocd = -1;
  for (let i = len - 22, stop = Math.max(0, len - 22 - 65535); i >= stop; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (end-of-central-directory not found)');

  let count = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);

  if (count === 0xFFFF || cdOff === 0xFFFFFFFF) {
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === SIG_EOCD64_LOC) {
      const z64 = Number(dv.getBigUint64(loc + 8, true));
      if (dv.getUint32(z64, true) === SIG_EOCD64) {
        count = Number(dv.getBigUint64(z64 + 32, true));
        cdOff = Number(dv.getBigUint64(z64 + 48, true));
      }
    }
  }

  // Walk the central directory.
  const entries = [];
  let p = cdOff;
  for (let n = 0; n < count && p + 46 <= len; n++) {
    if (dv.getUint32(p, true) !== SIG_CENTRAL) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let compSize = dv.getUint32(p + 20, true);
    let uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let localOff = dv.getUint32(p + 42, true);
    const name = decodeName(u8.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);

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
    entries.push({ name, method, compSize, localOff });
  }

  // Extract file data via the local headers.
  const out = [];
  for (const e of entries) {
    const q = e.localOff;
    if (q + 30 > len || dv.getUint32(q, true) !== SIG_LOCAL) continue;
    const nl = dv.getUint16(q + 26, true);
    const el = dv.getUint16(q + 28, true);
    const start = q + 30 + nl + el;
    const comp = u8.subarray(start, start + e.compSize);
    let data;
    if (e.method === 0) data = comp.slice();
    else if (e.method === 8) data = await inflateRaw(comp);
    else continue; // unsupported compression method
    out.push({ name: e.name, data });
  }
  return out;
}
