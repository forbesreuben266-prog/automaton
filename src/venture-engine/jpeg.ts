/**
 * Baseline JPEG encoder (JFIF, 8-bit YCbCr 4:4:4, standard quantisation and Huffman tables from the JPEG standard,
 * Annex K). Dependency-free and deterministic: the same canvas and quality give the same bytes. Instagram accepts only
 * JPEG images, so promotional cards are encoded with this.
 */

import type { Canvas } from "./raster.js";

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const LUM_Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const CHR_Q = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
const DC_LUM_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], DC_LUM_VAL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CHR_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], DC_CHR_VAL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUM_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUM_VAL = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];
const AC_CHR_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHR_VAL = [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];

type Table = { code: number[]; len: number[] };
function huffman(bits: number[], vals: number[]): Table {
  const code: number[] = new Array(256).fill(0), len: number[] = new Array(256).fill(0);
  let c = 0, k = 0;
  for (let l = 1; l <= 16; l++) { for (let i = 0; i < bits[l - 1]; i++) { code[vals[k]] = c; len[vals[k]] = l; c++; k++; } c <<= 1; }
  return { code, len };
}
const scaleQ = (q: number[], quality: number) => { const s = quality < 50 ? 5000 / quality : 200 - quality * 2; return q.map((v) => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100)))); };

// Separable float DCT-II on an 8x8 block (sufficient precision for baseline encoding).
const COS = Array.from({ length: 8 }, (_, x) => Array.from({ length: 8 }, (_, u) => Math.cos(((2 * x + 1) * u * Math.PI) / 16)));
const C = (u: number) => (u === 0 ? Math.SQRT1_2 : 1);
function fdct(block: Float64Array, out: Float64Array): void {
  const tmp = new Float64Array(64);
  for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) { let s = 0; for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[x][u]; tmp[y * 8 + u] = s * C(u) / 2; }
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) { let s = 0; for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS[y][v]; out[v * 8 + u] = s * C(v) / 2; }
}

class Bits {
  readonly bytes: number[] = []; private acc = 0; private n = 0;
  put(code: number, len: number) { for (let i = len - 1; i >= 0; i--) { this.acc = (this.acc << 1) | ((code >> i) & 1); this.n++; if (this.n === 8) { this.bytes.push(this.acc); if (this.acc === 0xff) this.bytes.push(0); this.acc = 0; this.n = 0; } } }
  flush() { if (this.n > 0) this.put((1 << (8 - this.n)) - 1, 8 - this.n); }
}
const category = (v: number) => { let a = Math.abs(v), n = 0; while (a) { n++; a >>= 1; } return n; };
const bitsOf = (v: number, n: number) => (v < 0 ? v + (1 << n) - 1 : v);

export function encodeJpeg(c: Canvas, quality = 90): Buffer {
  if (quality < 1 || quality > 100) throw new Error("quality: 1 to 100");
  const qy = scaleQ(LUM_Q, quality), qc = scaleQ(CHR_Q, quality);
  const dcY = huffman(DC_LUM_BITS, DC_LUM_VAL), dcC = huffman(DC_CHR_BITS, DC_CHR_VAL), acY = huffman(AC_LUM_BITS, AC_LUM_VAL), acC = huffman(AC_CHR_BITS, AC_CHR_VAL);
  const out: number[] = [];
  const marker = (m: number, body: number[]) => { out.push(0xff, m, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body); };
  out.push(0xff, 0xd8);
  marker(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 72, 0, 72, 0, 0]); // JFIF 1.01, 72 dpi
  marker(0xdb, [0x00, ...ZIGZAG.map((z) => qy[z]), 0x01, ...ZIGZAG.map((z) => qc[z])]);
  marker(0xc0, [8, c.height >> 8, c.height & 0xff, c.width >> 8, c.width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  marker(0xc4, [0x00, ...DC_LUM_BITS, ...DC_LUM_VAL, 0x10, ...AC_LUM_BITS, ...AC_LUM_VAL, 0x01, ...DC_CHR_BITS, ...DC_CHR_VAL, 0x11, ...AC_CHR_BITS, ...AC_CHR_VAL]);
  marker(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  const w = new Bits(), prev = [0, 0, 0];
  const blk = [new Float64Array(64), new Float64Array(64), new Float64Array(64)], coef = new Float64Array(64);
  const encodeBlock = (b: Float64Array, comp: number) => {
    const q = comp === 0 ? qy : qc, dc = comp === 0 ? dcY : dcC, ac = comp === 0 ? acY : acC;
    fdct(b, coef);
    const z = ZIGZAG.map((i) => Math.round(coef[i] / q[i]));
    const diff = z[0] - prev[comp]; prev[comp] = z[0];
    const cat = category(diff); w.put(dc.code[cat], dc.len[cat]); if (cat) w.put(bitsOf(diff, cat), cat);
    let run = 0;
    for (let i = 1; i < 64; i++) {
      if (z[i] === 0) { run++; continue; }
      while (run > 15) { w.put(ac.code[0xf0], ac.len[0xf0]); run -= 16; }
      const cs = category(z[i]), sym = (run << 4) | cs;
      w.put(ac.code[sym], ac.len[sym]); w.put(bitsOf(z[i], cs), cs); run = 0;
    }
    if (run > 0) w.put(ac.code[0], ac.len[0]);
  };
  for (let by = 0; by < c.height; by += 8) for (let bx = 0; bx < c.width; bx += 8) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const px = Math.min(c.width - 1, bx + x), py = Math.min(c.height - 1, by + y), i = (py * c.width + px) * 4;
      const r = c.data[i], g = c.data[i + 1], b = c.data[i + 2];
      blk[0][y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
      blk[1][y * 8 + x] = -0.168736 * r - 0.331264 * g + 0.5 * b;
      blk[2][y * 8 + x] = 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    encodeBlock(blk[0], 0); encodeBlock(blk[1], 1); encodeBlock(blk[2], 2);
  }
  w.flush();
  return Buffer.concat([Buffer.from(out), Buffer.from(w.bytes), Buffer.from([0xff, 0xd9])]);
}
