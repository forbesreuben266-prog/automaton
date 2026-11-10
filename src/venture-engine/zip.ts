/**
 * Minimal ZIP archives for product deliverables (no dependency): deflate via node:zlib, CRC-32, one flat folder of
 * plain file names. readZip parses the central directory, inflates every entry and checks CRC and size, so
 * verifyZip can prove an archive extracts to exactly the manifest (names, sizes, SHA-256).
 */

import { createHash } from "node:crypto";
import zlib from "node:zlib";

const SAFE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b: Buffer): number { let c = 0xffffffff; for (const x of b) c = TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export interface ZipEntry { readonly name: string; readonly bytes: number; readonly sha256: string }
export const MAX_ENTRIES = 30;
export const MAX_ENTRY_BYTES = 512 * 1024;

/** Builds an archive from plain file names only (no folders, no '..', no absolute paths); fixed timestamps (reproducible). */
export function makeZip(files: readonly { readonly name: string; readonly data: Buffer }[]): Buffer {
  if (!files.length || files.length > MAX_ENTRIES) throw new Error(`zip: 1 to ${MAX_ENTRIES} files`);
  const seen = new Set<string>();
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    if (!SAFE.test(f.name) || f.name.includes("..")) throw new Error(`zip: unsafe file name ${JSON.stringify(f.name.slice(0, 40))}`);
    if (seen.has(f.name)) throw new Error(`zip: duplicate file ${f.name}`);
    if (f.data.length > MAX_ENTRY_BYTES) throw new Error(`zip: ${f.name} is too large`);
    seen.add(f.name);
    const name = Buffer.from(f.name, "utf8"), body = zlib.deflateRawSync(f.data, { level: 9 }), crc = crc32(f.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x5a21, 12); // 2025-01-01 00:00 (DOS date), fixed for reproducible archives
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x031e, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x5a21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE((0o100644 << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

/** Reads every entry (central directory + local headers), inflating and checking CRC and size. Throws on anything odd. */
export function readZip(zip: Buffer): { name: string; data: Buffer }[] {
  const e = zip.length - 22;
  if (e < 0 || zip.readUInt32LE(e) !== 0x06054b50) throw new Error("zip: no end-of-archive record (or a comment, which is not allowed)");
  const count = zip.readUInt16LE(e + 10), size = zip.readUInt32LE(e + 12), start = zip.readUInt32LE(e + 16);
  if (count > MAX_ENTRIES || start + size !== e) throw new Error("zip: unexpected central directory");
  const out: { name: string; data: Buffer }[] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("zip: bad central directory entry");
    const method = zip.readUInt16LE(p + 10), crc = zip.readUInt32LE(p + 16), csize = zip.readUInt32LE(p + 20), usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28), xlen = zip.readUInt16LE(p + 30), clen = zip.readUInt16LE(p + 32), off = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString("utf8");
    if (!SAFE.test(name) || name.includes("..")) throw new Error(`zip: unsafe entry name ${JSON.stringify(name.slice(0, 40))}`);
    if (method !== 8 || usize > MAX_ENTRY_BYTES) throw new Error(`zip: ${name}: unsupported method or too large`);
    if (zip.readUInt32LE(off) !== 0x04034b50 || zip.subarray(off + 30, off + 30 + zip.readUInt16LE(off + 26)).toString("utf8") !== name) throw new Error(`zip: ${name}: local header mismatch`);
    const body = off + 30 + zip.readUInt16LE(off + 26) + zip.readUInt16LE(off + 28);
    const data = zlib.inflateRawSync(zip.subarray(body, body + csize), { maxOutputLength: MAX_ENTRY_BYTES });
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`zip: ${name}: size or CRC mismatch`);
    out.push({ name, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** Problems found when comparing an archive with the expected manifest; empty means it extracts to exactly the manifest. */
export function verifyZip(zip: Buffer, manifest: readonly ZipEntry[]): string[] {
  let entries: { name: string; data: Buffer }[];
  try { entries = readZip(zip); } catch (e) { return [(e as Error).message]; }
  const out: string[] = [];
  const want = new Map(manifest.map((m) => [m.name, m]));
  for (const x of entries) {
    const m = want.get(x.name);
    if (!m) { out.push(`unexpected file in archive: ${x.name}`); continue; }
    if (x.data.length !== m.bytes || sha(x.data) !== m.sha256) out.push(`${x.name}: content differs from the manifest`);
    want.delete(x.name);
  }
  for (const n of want.keys()) out.push(`missing from archive: ${n}`);
  return out;
}

export const zipManifest = (files: readonly { name: string; data: Buffer }[]): ZipEntry[] => files.map((f) => ({ name: f.name, bytes: f.data.length, sha256: sha(f.data) }));
