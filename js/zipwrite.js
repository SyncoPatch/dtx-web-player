// Minimal ZIP writer: stored (uncompressed) entries with UTF-8 names.
// Song packages are mostly already-compressed audio, so deflating buys little.
// File data stays lazy Blob parts and the CRC is computed by streaming each
// blob, so a library export never holds a whole file in memory. Zip64
// records are written when an entry, an offset or the entry count passes the
// classic limits (4 GB / 65535 entries).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

async function crc32Blob(blob) {
  let c = 0xFFFFFFFF;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) c = CRC_TABLE[(c ^ value[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const MAX32 = 0xFFFFFFFF;
const MAX16 = 0xFFFF;
const u64 = (dv, at, v) => { dv.setUint32(at, v % 0x100000000, true); dv.setUint32(at + 4, Math.floor(v / 0x100000000), true); };

// entries: [{ name, blob }] → Blob (application/zip)
// opts.onProgress(done, total); opts.forceZip64 (tests) writes Zip64 records
// even for small archives.
export async function createZip(entries, { onProgress, forceZip64 = false } = {}) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const { name, blob } = entries[i];
    const nameBytes = enc.encode(name);
    const crc = await crc32Blob(blob);
    const size = blob.size;
    const big = forceZip64 || size >= MAX32;
    const farOffset = forceZip64 || offset >= MAX32;

    // Local header; Zip64 extra holds both sizes when they don't fit.
    const localExtra = big ? 20 : 0;
    const local = new DataView(new ArrayBuffer(30 + localExtra));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, big ? 45 : 20, true); // version needed
    local.setUint16(6, 0x0800, true);        // UTF-8 names
    local.setUint16(8, 0, true);             // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, big ? MAX32 : size, true);
    local.setUint32(22, big ? MAX32 : size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, localExtra, true);
    if (big) {
      local.setUint16(30, 0x0001, true);
      local.setUint16(32, 16, true);
      u64(local, 34, size);
      u64(local, 42, size);
    }
    // The name goes between the fixed header and the extra field.
    const head = new Uint8Array(local.buffer);
    parts.push(head.subarray(0, 30), nameBytes, head.subarray(30), blob);

    // Central directory: the Zip64 extra lists only the fields set to MAX32,
    // in the order uncompressed size, compressed size, local header offset.
    const cdExtra = (big ? 16 : 0) + (farOffset ? 8 : 0);
    const cd = new DataView(new ArrayBuffer(46 + (cdExtra ? 4 + cdExtra : 0)));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, cdExtra ? 45 : 20, true); // version made by
    cd.setUint16(6, cdExtra ? 45 : 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, big ? MAX32 : size, true);
    cd.setUint32(24, big ? MAX32 : size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, cdExtra ? 4 + cdExtra : 0, true);
    cd.setUint32(42, farOffset ? MAX32 : offset, true);
    if (cdExtra) {
      let p = 46;
      cd.setUint16(p, 0x0001, true);
      cd.setUint16(p + 2, cdExtra, true);
      p += 4;
      if (big) { u64(cd, p, size); u64(cd, p + 8, size); p += 16; }
      if (farOffset) u64(cd, p, offset);
    }
    const cdHead = new Uint8Array(cd.buffer);
    central.push(cdHead.subarray(0, 46), nameBytes, cdHead.subarray(46));

    offset += 30 + nameBytes.length + localExtra + size;
    onProgress?.(i + 1, entries.length);
  }

  const cdSize = central.reduce((a, p) => a + p.byteLength, 0);
  const cdOffset = offset;
  const tail = [];
  const zip64End = forceZip64 || entries.length >= MAX16 || cdOffset >= MAX32 || cdSize >= MAX32;
  if (zip64End) {
    const rec = new DataView(new ArrayBuffer(56));
    rec.setUint32(0, 0x06064b50, true);
    u64(rec, 4, 44);                // size of the rest of this record
    rec.setUint16(12, 45, true);
    rec.setUint16(14, 45, true);
    u64(rec, 24, entries.length);   // entries on this disk
    u64(rec, 32, entries.length);
    u64(rec, 40, cdSize);
    u64(rec, 48, cdOffset);
    const loc = new DataView(new ArrayBuffer(20));
    loc.setUint32(0, 0x07064b50, true);
    u64(loc, 8, cdOffset + cdSize); // where the Zip64 end record starts
    loc.setUint32(16, 1, true);     // total disks
    tail.push(rec.buffer, loc.buffer);
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, zip64End ? MAX16 : entries.length, true);
  eocd.setUint16(10, zip64End ? MAX16 : entries.length, true);
  eocd.setUint32(12, zip64End ? MAX32 : cdSize, true);
  eocd.setUint32(16, zip64End ? MAX32 : cdOffset, true);
  tail.push(eocd.buffer);

  return new Blob([...parts, ...central, ...tail], { type: 'application/zip' });
}
