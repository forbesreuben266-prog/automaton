/**
 * Minimal, dependency-free raster graphics for promotional cards: an RGBA canvas, rectangles, anti-aliased text from
 * an embedded glyph atlas (font-atlas.ts), word wrapping, and a PNG encoder (node:zlib). Output is deterministic:
 * the same inputs give byte-identical files. Also reads the dimensions of owner-supplied PNG/JPEG screenshots without
 * decoding or changing them.
 */

import zlib from "node:zlib";
import { ATLAS_DATA, ATLAS_META } from "./font-atlas.js";
import { crc32 } from "./zip.js";

export type Style = keyof typeof ATLAS_META;
export interface Canvas { readonly width: number; readonly height: number; readonly data: Uint8Array }
export type RGB = readonly [number, number, number];

let atlas: Buffer | null = null;
const bitmaps = () => (atlas ??= zlib.inflateSync(Buffer.from(ATLAS_DATA, "base64")));
type Glyph = readonly [number, number, number, number, number, number];
const glyph = (s: Style, ch: string): Glyph => ((ATLAS_META[s].glyphs as Record<string, Glyph>)[ch] ?? (ATLAS_META[s].glyphs as Record<string, Glyph>)["?"]);

export function canvas(width: number, height: number, bg: RGB): Canvas {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 4_000_000) throw new Error("canvas: 1 to 4 megapixels");
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = bg[0]; data[i + 1] = bg[1]; data[i + 2] = bg[2]; data[i + 3] = 255; }
  return { width, height, data };
}

export function rect(c: Canvas, x: number, y: number, w: number, h: number, color: RGB): void {
  for (let yy = Math.max(0, y); yy < Math.min(c.height, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(c.width, x + w); xx++) {
    const i = (yy * c.width + xx) * 4; c.data[i] = color[0]; c.data[i + 1] = color[1]; c.data[i + 2] = color[2];
  }
}

const normalise = (s: string) => s.replace(/[‘’]/g, "’").replace(/\s+/g, " ").trim();
export function measure(text: string, s: Style): number { let w = 0; for (const ch of normalise(text)) w += glyph(s, ch)[0]; return w; }

/** Greedy word wrap to a pixel width; words longer than the line are kept whole. */
export function wrap(text: string, s: Style, maxWidth: number): string[] {
  const lines: string[] = []; let line = "";
  for (const word of normalise(text).split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, s) > maxWidth) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Draws one line with its top at y (alpha-blended). */
export function text(c: Canvas, str: string, x: number, y: number, s: Style, color: RGB): void {
  const bm = bitmaps();
  let pen = x;
  for (const ch of normalise(str)) {
    const [adv, ox, oy, w, h, off] = glyph(s, ch);
    for (let gy = 0; gy < h; gy++) for (let gx = 0; gx < w; gx++) {
      const a = bm[off + gy * w + gx]; if (!a) continue;
      const px = pen + ox + gx, py = y + oy + gy;
      if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue;
      const i = (py * c.width + px) * 4;
      for (let k = 0; k < 3; k++) c.data[i + k] = Math.round((color[k] * a + c.data[i + k] * (255 - a)) / 255);
    }
    pen += adv;
  }
}
export const lineHeight = (s: Style) => Math.round((ATLAS_META[s].ascent + ATLAS_META[s].descent) * 1.15);

export function encodePng(c: Canvas): Buffer {
  const chunk = (type: string, body: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type, "ascii"), body]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb)); return Buffer.concat([len, tb, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(c.width, 0); ihdr.writeUInt32BE(c.height, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((c.width * 3 + 1) * c.height);
  for (let y = 0; y < c.height; y++) { const row = y * (c.width * 3 + 1); raw[row] = 0; for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4, o = row + 1 + x * 3; raw[o] = c.data[i]; raw[o + 1] = c.data[i + 1]; raw[o + 2] = c.data[i + 2]; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Type and size of a PNG or JPEG file from its header (the file itself is never changed). */
export function imageInfo(b: Buffer): { type: "png" | "jpeg"; width: number; height: number } {
  if (b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.toString("ascii", 12, 16) === "IHDR") return { type: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) throw new Error("not a valid JPEG");
      const m = b[p + 1], len = b.readUInt16BE(p + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { type: "jpeg", width: b.readUInt16BE(p + 7), height: b.readUInt16BE(p + 5) };
      p += 2 + len;
    }
    throw new Error("JPEG without a frame header");
  }
  throw new Error("only PNG or JPEG images are accepted");
}
