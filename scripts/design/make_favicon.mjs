#!/usr/bin/env node
// Regenerates ui/public/'s favicon set and the sidebar brand mark from the
// project logo.
//
// Committed output, run by hand — not a gate. It exists so the icons are
// reproducible from the source art instead of being opaque binaries nobody
// can regenerate once the original is lost:
//
//   node scripts/design/make_favicon.mjs [source.png] [outDir] [brandDir]
//
// No ImageMagick: this box-filters in Node so the only dependency is the
// runtime the repo already pins. The source is a palette PNG with tRNS
// (colour type 3), so that is the one input format decoded here — it throws
// on anything else rather than writing a silently wrong icon.
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- CRC32, for the PNG chunks we write ---------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// --- Decode: palette PNG -> {w, h, rgba} --------------------------------
function decodePalettePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');

  let ihdr = null;
  let plte = null;
  let trns = null;
  const idat = [];

  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }

  if (!ihdr) throw new Error('no IHDR');
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (colorType !== 3 || bitDepth !== 8 || interlace !== 0) {
    throw new Error(
      `unsupported PNG: colorType=${colorType} bitDepth=${bitDepth} interlace=${interlace} ` +
        '(this script decodes 8-bit non-interlaced palette PNGs only)',
    );
  }
  if (!plte) throw new Error('palette PNG without PLTE');

  // One byte per pixel, so the filter's "prior byte" distance is 1.
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width + 1;
  const idx = Buffer.alloc(width * height);
  let prev = Buffer.alloc(width);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    const line = raw.subarray(y * stride + 1, y * stride + 1 + width);
    const out = Buffer.alloc(width);
    for (let x = 0; x < width; x++) {
      const a = x >= 1 ? out[x - 1] : 0;
      const b = prev[x];
      const c = x >= 1 ? prev[x - 1] : 0;
      const v = line[x];
      let recon;
      switch (filter) {
        case 0:
          recon = v;
          break;
        case 1:
          recon = v + a;
          break;
        case 2:
          recon = v + b;
          break;
        case 3:
          recon = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          recon = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad filter type ${filter} on row ${y}`);
      }
      out[x] = recon & 0xff;
    }
    out.copy(idx, y * width);
    prev = out;
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = idx[i];
    rgba[i * 4] = plte[p * 3];
    rgba[i * 4 + 1] = plte[p * 3 + 1];
    rgba[i * 4 + 2] = plte[p * 3 + 2];
    // tRNS is a prefix of the palette; entries past its end are opaque.
    rgba[i * 4 + 3] = trns && p < trns.length ? trns[p] : 255;
  }
  return { w: width, h: height, rgba };
}

// --- Encode: {w, h, rgba} -> PNG buffer ---------------------------------
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng({ w, h, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // Filter type 0 (None) on every row. These are 16-180px images; the bytes
  // saved by a smarter filter choice are not worth the code to pick one.
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Geometry -----------------------------------------------------------

/** Tightest box holding every pixel that is not effectively transparent. */
function alphaBounds(img, threshold = 8) {
  let minX = img.w;
  let minY = img.h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.rgba[(y * img.w + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('source image is entirely transparent');
  return { minX, minY, maxX, maxY };
}

/**
 * Box-filter `src` down to `size`, reading from an arbitrary square window
 * that may hang off the edge of the image (treated as transparent). Alpha is
 * premultiplied before averaging and divided back out after: averaging raw
 * RGB would drag the colour of fully transparent pixels into the edges and
 * ring the artwork with a halo.
 */
function resample(src, win, size) {
  const out = Buffer.alloc(size * size * 4);
  const step = win.size / size;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      const x0 = Math.floor(win.x + ox * step);
      const x1 = Math.max(x0 + 1, Math.floor(win.x + (ox + 1) * step));
      const y0 = Math.floor(win.y + oy * step);
      const y1 = Math.max(y0 + 1, Math.floor(win.y + (oy + 1) * step));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          n++;
          if (x < 0 || y < 0 || x >= src.w || y >= src.h) continue;
          const i = (y * src.w + x) * 4;
          const av = src.rgba[i + 3] / 255;
          r += src.rgba[i] * av;
          g += src.rgba[i + 1] * av;
          b += src.rgba[i + 2] * av;
          a += av;
        }
      }
      const o = (oy * size + ox) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return { w: size, h: size, rgba: out };
}

/** Composite over an opaque colour — iOS renders a transparent icon black. */
function flatten(img, [br, bg, bb]) {
  const out = Buffer.alloc(img.rgba.length);
  for (let i = 0; i < img.rgba.length; i += 4) {
    const a = img.rgba[i + 3] / 255;
    out[i] = Math.round(img.rgba[i] * a + br * (1 - a));
    out[i + 1] = Math.round(img.rgba[i + 1] * a + bg * (1 - a));
    out[i + 2] = Math.round(img.rgba[i + 2] * a + bb * (1 - a));
    out[i + 3] = 255;
  }
  return { w: img.w, h: img.h, rgba: out };
}

// --- ICO ----------------------------------------------------------------
// PNG-compressed entries, which every browser since IE11 reads. Sizes are
// 16/32/48: the classic tab/bookmark/shortcut trio.
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size; // 0 means 256
    dir[e + 1] = size >= 256 ? 0 : size;
    dir[e + 2] = 0; // palette size
    dir[e + 3] = 0; // reserved
    dir.writeUInt16LE(1, e + 4); // colour planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

// --- Main ---------------------------------------------------------------
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const srcPath =
  process.argv[2] ?? path.join(repoRoot, 'ui', 'src', 'assets', 'brand', 'black-smith.png');
const outDir = process.argv[3] ?? path.join(repoRoot, 'ui', 'public');
const brandDir = process.argv[4] ?? path.join(repoRoot, 'ui', 'src', 'assets', 'brand');

const src = decodePalettePng(readFileSync(srcPath));
const b = alphaBounds(src);

// The logo is the mascot's head on transparency — no plate, no disc, so the
// alpha box is the artwork itself and nothing else. The right framing is to
// let it fill the icon edge to edge — PADDING = 1. Inset it and a 16px tab
// icon spends its few pixels on empty margin. The head is taller than it is
// wide, so the square, centred window takes the larger side and leaves the
// slack as side margin; that keeps the aspect ratio honest and the framing
// identical at every output size.
const PADDING = 1;
const contentW = b.maxX - b.minX + 1;
const contentH = b.maxY - b.minY + 1;
const win = { size: Math.round(Math.max(contentW, contentH) * PADDING) };
win.x = b.minX + contentW / 2 - win.size / 2;
win.y = b.minY + contentH / 2 - win.size / 2;

mkdirSync(outDir, { recursive: true });
mkdirSync(brandDir, { recursive: true });

const writeTo = (dir) => (name, buf) => {
  writeFileSync(path.join(dir, name), buf);
  console.log(`  ${name.padEnd(22)} ${String(buf.length).padStart(7)} bytes`);
};
const write = writeTo(outDir);
const writeBrand = writeTo(brandDir);

console.log(`source ${path.relative(repoRoot, srcPath)} ${src.w}x${src.h}`);
console.log(
  `ink    x ${b.minX}..${b.maxX}, y ${b.minY}..${b.maxY} ` +
    `(${contentW}x${contentH}) -> ${win.size}px square window`,
);
console.log(`out    ${path.relative(repoRoot, outDir)}/`);

const icoSizes = [16, 32, 48];
const icoEntries = icoSizes.map((size) => ({
  size,
  data: encodePng(resample(src, win, size)),
}));
write('favicon.ico', encodeIco(icoEntries));

// Modern browsers prefer these over the .ico when both are declared.
write('favicon-16.png', icoEntries[0].data);
write('favicon-32.png', icoEntries[1].data);
write('favicon-192.png', encodePng(resample(src, win, 192)));

// iOS ignores transparency and has no dark-mode compositing, so this one is
// flattened onto white to match the artwork's own background.
write('apple-touch-icon.png', encodePng(flatten(resample(src, win, 180), [255, 255, 255])));

// The sidebar's brand mark. It goes to ui/src/assets/ rather than public/ so
// Vite hashes it into the bundle like coffee.svg — a cache-busted import, not
// a bare path that can rot. Rendered at 24px CSS, so 96 covers a 4x display
// and still costs a fraction of the 192px favicon.
console.log(`brand  ${path.relative(repoRoot, brandDir)}/`);
writeBrand('mark-96.png', encodePng(resample(src, win, 96)));
