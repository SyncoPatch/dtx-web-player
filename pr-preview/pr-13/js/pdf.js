// Minimal PDF writer: vector paths, standard Helvetica text (no font
// embedding), and RGB images (Flate-compressed when CompressionStream is
// available). Enough for engraved sheet music; no external dependencies.
//
// Coordinates are top-down (like canvas); they are flipped to PDF's
// bottom-up space internally.

// Helvetica advance widths (per mille) for chars 32..126, from the AFM.
// Used for center/right alignment; close enough for Bold/Oblique too.
const HELV_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const FONTS = { R: 'Helvetica', B: 'Helvetica-Bold', I: 'Helvetica-Oblique' };

const K = 0.5522847498; // bezier circle constant

function num(v) {
  return Math.round(v * 100) / 100;
}

function escapeText(str) {
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c >= 32 && c <= 126) out += ch;
    else out += '?'; // non-ASCII: callers should rasterize such text instead
  }
  return out;
}

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate');
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

class Page {
  constructor(doc) {
    this.doc = doc;
    this.h = doc.h;
    this.ops = [];
    this.images = []; // { name, width, height, data }
  }

  _y(y) { return num(this.h - y); }

  setFill(gray) { this.ops.push(`${num(gray)} g`); }
  setStroke(gray) { this.ops.push(`${num(gray)} G`); }
  setLineWidth(w) { this.ops.push(`${num(w)} w`); }

  line(x1, y1, x2, y2) {
    this.ops.push(`${num(x1)} ${this._y(y1)} m ${num(x2)} ${this._y(y2)} l S`);
  }

  rect(x, y, w, h, fill = true) {
    this.ops.push(`${num(x)} ${this._y(y + h)} ${num(w)} ${num(h)} re ${fill ? 'f' : 'S'}`);
  }

  ellipse(cx, cy, rx, ry, fill = true) {
    const x = num(cx), y = this._y(cy);
    const kx = num(rx * K), ky = num(ry * K);
    rx = num(rx); ry = num(ry);
    this.ops.push(
      `${num(x - rx)} ${y} m ` +
      `${num(x - rx)} ${num(y + ky)} ${num(x - kx)} ${num(y + ry)} ${x} ${num(y + ry)} c ` +
      `${num(x + kx)} ${num(y + ry)} ${num(x + rx)} ${num(y + ky)} ${num(x + rx)} ${y} c ` +
      `${num(x + rx)} ${num(y - ky)} ${num(x + kx)} ${num(y - ry)} ${x} ${num(y - ry)} c ` +
      `${num(x - kx)} ${num(y - ry)} ${num(x - rx)} ${num(y - ky)} ${num(x - rx)} ${y} c ` +
      (fill ? 'f' : 'S'),
    );
  }

  // segs: ['M',x,y] | ['L',x,y] | ['C',x1,y1,x2,y2,x,y]
  path(segs, { fill = false, stroke = false, close = false } = {}) {
    let s = '';
    for (const seg of segs) {
      if (seg[0] === 'M') s += `${num(seg[1])} ${this._y(seg[2])} m `;
      else if (seg[0] === 'L') s += `${num(seg[1])} ${this._y(seg[2])} l `;
      else if (seg[0] === 'C') {
        s += `${num(seg[1])} ${this._y(seg[2])} ${num(seg[3])} ${this._y(seg[4])} ` +
             `${num(seg[5])} ${this._y(seg[6])} c `;
      }
    }
    if (close) s += 'h ';
    s += fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.ops.push(s);
  }

  textWidth(str, size) {
    let w = 0;
    for (const ch of str) {
      const c = ch.codePointAt(0);
      w += (c >= 32 && c <= 126 ? HELV_WIDTHS[c - 32] : 556) / 1000;
    }
    return w * size;
  }

  // y is the baseline (top-down).
  text(x, y, str, { size = 10, font = 'R', align = 'left' } = {}) {
    let tx = x;
    if (align !== 'left') {
      const w = this.textWidth(str, size);
      tx = align === 'center' ? x - w / 2 : x - w;
    }
    this.ops.push(`BT /F${font} ${num(size)} Tf ${num(tx)} ${this._y(y)} Td (${escapeText(str)}) Tj ET`);
  }

  // img: { width, height, data: Uint8Array (RGB, 3 bytes/px) }
  image(x, y, w, h, img) {
    const name = `Im${this.doc._imgCount++}`;
    this.images.push({ name, ...img });
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${this._y(y + h)} cm /${name} Do Q`);
  }
}

export class PDFDoc {
  constructor(w = 595, h = 842) { // A4 portrait, points
    this.w = w;
    this.h = h;
    this.pages = [];
    this._imgCount = 0;
  }

  addPage() {
    const p = new Page(this);
    this.pages.push(p);
    return p;
  }

  async finish() {
    const enc = new TextEncoder();
    const chunks = [];
    let offset = 0;
    const offsets = [0]; // object number -> byte offset (index 0 unused)
    const push = (data) => {
      const bytes = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(bytes);
      offset += bytes.length;
    };
    const beginObj = () => {
      offsets.push(offset);
      const n = offsets.length - 1;
      push(`${n} 0 obj\n`);
      return n;
    };

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    // Fixed object numbers: 1 catalog, 2 pages, 3-5 fonts, then per page.
    const catalogN = beginObj();
    push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    const pagesN = beginObj();
    const kidRefs = [];
    // Reserve: we need kid object numbers before writing; compute layout:
    // objects so far: 1,2 then fonts 3,4,5; each page uses:
    //   [image objects...] + content + page — numbered in write order below.
    // We can't know numbers ahead without a dry run, so write the Pages
    // object last via a placeholder: instead, write Pages *after* pages and
    // point the catalog at a fixed number 2 by reserving it here.
    push('PLACEHOLDER'); // replaced below
    const pagesChunkIdx = chunks.length - 1;
    const pagesOffset = offsets[pagesN];
    push('\nendobj\n');

    for (const [key, name] of [['R', 3], ['B', 4], ['I', 5]]) {
      beginObj();
      push(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS[key]} /Encoding /WinAnsiEncoding >>\nendobj\n`);
    }

    for (const page of this.pages) {
      // Image XObjects first.
      const imgRefs = [];
      for (const img of page.images) {
        const flated = await deflate(img.data);
        const data = flated || img.data;
        const n = beginObj();
        push(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
             `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
             (flated ? '/Filter /FlateDecode ' : '') +
             `/Length ${data.length} >>\nstream\n`);
        push(data);
        push('\nendstream\nendobj\n');
        imgRefs.push({ name: img.name, ref: n });
      }
      const content = enc.encode(page.ops.join('\n'));
      const contentN = beginObj();
      push(`<< /Length ${content.length} >>\nstream\n`);
      push(content);
      push('\nendstream\nendobj\n');
      const pageN = beginObj();
      const xobj = imgRefs.length
        ? ` /XObject << ${imgRefs.map((r) => `/${r.name} ${r.ref} 0 R`).join(' ')} >>`
        : '';
      push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.w} ${this.h}] ` +
           `/Resources << /Font << /FR 3 0 R /FB 4 0 R /FI 5 0 R >>${xobj} >> ` +
           `/Contents ${contentN} 0 R >>\nendobj\n`);
      kidRefs.push(`${pageN} 0 R`);
    }

    // Fill in the Pages object placeholder (recompute offsets afterwards).
    const pagesBody = `<< /Type /Pages /Kids [${kidRefs.join(' ')}] /Count ${this.pages.length} >>`;
    const placeholder = chunks[pagesChunkIdx];
    const replacement = enc.encode(pagesBody);
    chunks[pagesChunkIdx] = replacement;
    const delta = replacement.length - placeholder.length;
    // Shift every offset recorded after the placeholder.
    for (let i = 1; i < offsets.length; i++) {
      if (offsets[i] > pagesOffset) offsets[i] += delta;
    }
    offset += delta;

    const xrefStart = offset;
    let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < offsets.length; i++) {
      xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    push(xref);
    push(`trailer\n<< /Size ${offsets.length} /Root ${catalogN} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    const total = chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
  }
}
