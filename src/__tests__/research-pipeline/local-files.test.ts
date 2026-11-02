/**
 * Local-file loader (Phase 1A step 3). FICTIONAL inputs only, written to a
 * fresh temporary data root for each test (outside the repository). No real
 * research material, no network.
 */

import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalFileError, MAX_MANIFEST_BYTES, MAX_OPPORTUNITY_BYTES, MAX_SOURCE_BYTES, MAX_TOTAL_SOURCE_BYTES, MAX_WORKBOOK_BYTES, loadRun,
} from "../../research-pipeline/local-files.js";
import { AS_OF, OPPORTUNITY_ID, validManifest, validOpportunity, validWorkbook } from "./fixtures.js";
import { validReport } from "../business-research/fixtures.js";

const REPO = path.resolve(__dirname, "../../..");
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

interface Run {
  root: string; dataRoot: string; oppDir: string; runDir: string; sourcesDir: string;
  location: { dataRoot: string; repositoryRoot: string; opportunityId: string; runId: string };
  manifest: any;
  writeManifest: () => void;
}

/** Writes the fictional run into a new temporary data root (canonical path, no symlinks). */
function makeRun(): Run {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rp-local-")));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const oppDir = path.join(dataRoot, OPPORTUNITY_ID);
  const runDir = path.join(oppDir, "runs", AS_OF);
  const sourcesDir = path.join(runDir, "sources");
  fs.mkdirSync(sourcesDir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(oppDir, "opportunity.json"), JSON.stringify(validOpportunity()));
  fs.writeFileSync(path.join(runDir, "workbook.json"), JSON.stringify(validWorkbook()));
  const manifest = validManifest();
  for (const s of validReport().snapshots) fs.writeFileSync(path.join(sourcesDir, `${s.id}.txt`), s.content, "utf8");
  const run: Run = {
    root, dataRoot, oppDir, runDir, sourcesDir, manifest,
    location: { dataRoot, repositoryRoot: REPO, opportunityId: OPPORTUNITY_ID, runId: AS_OF },
    writeManifest: () => fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest)),
  };
  run.writeManifest();
  return run;
}

/** Replaces a source's bytes and records the matching hash, so only the property under test fails. */
function setSource(run: Run, index: number, bytes: Uint8Array | string): void {
  fs.writeFileSync(path.join(run.sourcesDir, run.manifest.sources[index].file), bytes);
  run.manifest.sources[index].sha256 = sha256(bytes);
  run.writeManifest();
}

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LocalFileError);
    return (err as LocalFileError).reasons.join("\n");
  }
  throw new Error("expected a refusal");
};

describe("valid fictional run", () => {
  it("loads the opportunity, manifest, workbook and every source, in manifest order, with matching hashes", () => {
    const run = makeRun();
    const loaded = loadRun(run.location);
    expect(loaded.opportunity.id).toBe(OPPORTUNITY_ID);
    expect(loaded.manifest.runDate).toBe(AS_OF);
    expect(loaded.workbook.reportId).toBe(validWorkbook().reportId);
    expect(loaded.sources.map((s) => s.id)).toEqual(run.manifest.sources.map((s: any) => s.id));
    const snapshots = validReport().snapshots;
    loaded.sources.forEach((s, i) => {
      expect(s.content).toBe(snapshots[i].content);
      expect(s.sha256).toBe(run.manifest.sources[i].sha256);
      expect(s.bytes).toBe(Buffer.byteLength(snapshots[i].content, "utf8"));
    });
    expect(Object.isFrozen(loaded) && Object.isFrozen(loaded.sources) && Object.isFrozen(loaded.sources[0])).toBe(true);
  });

  it("is deterministic and read-only: the same result twice, and no input is written, renamed or deleted", () => {
    const run = makeRun();
    const snapshot = () => {
      const out: Record<string, string> = {};
      const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const p = path.join(d, e.name);
        const st = fs.lstatSync(p);
        out[p] = `${st.mode}:${st.size}:${st.mtimeMs}:${st.ino}:${e.isFile() ? sha256(fs.readFileSync(p)) : "dir"}`;
        if (e.isDirectory()) walk(p);
      });
      walk(run.dataRoot);
      return out;
    };
    const before = snapshot();
    const writers = ["writeFileSync", "writeSync", "appendFileSync", "renameSync", "unlinkSync", "rmSync", "rmdirSync", "mkdirSync", "chmodSync", "chownSync",
      "truncateSync", "ftruncateSync", "copyFileSync", "symlinkSync", "linkSync", "utimesSync", "futimesSync", "writeFile", "rename", "unlink", "rm"];
    const calls: string[] = [];
    for (const name of writers) {
      if (typeof (fs as any)[name] === "function") vi.spyOn(fs as any, name).mockImplementation((() => { calls.push(name); throw new Error(`${name} called`); }) as any);
    }
    const a = loadRun(run.location);
    const b = loadRun(run.location);
    vi.restoreAllMocks();
    expect(calls).toEqual([]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(snapshot()).toEqual(before);
  });
});

describe("location: validated before any filesystem access", () => {
  it.each([
    ["a relative data root", { dataRoot: "data" }, "dataRoot: must be a normalized absolute path"],
    ["a data root with ..", { dataRoot: "/srv/../etc" }, "dataRoot: must be a normalized absolute path"],
    ["a data root with a trailing slash", { dataRoot: "/srv/research-data/" }, "dataRoot: must be a normalized absolute path"],
    ["the filesystem root", { dataRoot: "/" }, "dataRoot: must be a normalized absolute path"],
    ["a non-string data root", { dataRoot: 42 }, "dataRoot: must be a normalized absolute path"],
    ["a data root inside the repository", { dataRoot: `${REPO}/research-data` }, "dataRoot: must be outside the repository"],
    ["the repository itself", { dataRoot: REPO }, "dataRoot: must be outside the repository"],
    ["a data root containing the repository", { dataRoot: path.dirname(REPO) }, "dataRoot: must be outside the repository"],
    ["a relative repository root", { repositoryRoot: "." }, "repositoryRoot: must be a normalized absolute path"],
    ["a traversing opportunity id", { opportunityId: "../etc" }, "opportunityId: must be a plain lower-case name"],
    ["an opportunity id with a separator", { opportunityId: "a/b" }, "opportunityId"],
    ["a hidden opportunity id", { opportunityId: ".hidden" }, "opportunityId"],
    ["an empty opportunity id", { opportunityId: "" }, "opportunityId"],
    ["an absolute run id", { runId: "/etc" }, "runId: must be a plain lower-case name"],
    ["a dot run id", { runId: ".." }, "runId"],
    ["an upper-case run id", { runId: "Run1" }, "runId"],
  ])("refuses %s, without touching the filesystem", (_label, patch, message) => {
    const lstat = vi.spyOn(fs, "lstatSync");
    const open = vi.spyOn(fs, "openSync");
    const base = { dataRoot: "/srv/research-data", repositoryRoot: REPO, opportunityId: OPPORTUNITY_ID, runId: AS_OF };
    expect(refusal(() => loadRun({ ...base, ...patch }))).toContain(message);
    expect(lstat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a non-object location", () => {
    expect(refusal(() => loadRun(null))).toContain("location: must be an object");
  });
});

describe("symlinks are refused in every component", () => {
  it.each([
    ["the opportunity directory", (r: Run) => r.oppDir],
    ["the runs directory", (r: Run) => path.join(r.oppDir, "runs")],
    ["the run directory", (r: Run) => r.runDir],
    ["the sources directory", (r: Run) => r.sourcesDir],
    ["the manifest", (r: Run) => path.join(r.runDir, "manifest.json")],
    ["the opportunity file", (r: Run) => path.join(r.oppDir, "opportunity.json")],
    ["a source file", (r: Run) => path.join(r.sourcesDir, r.manifest.sources[0].file)],
  ])("%s replaced by a symlink to an identical copy", (_label, pick) => {
    const run = makeRun();
    const target = pick(run);
    const copy = path.join(run.root, "elsewhere");
    fs.cpSync(target, copy, { recursive: true });
    fs.rmSync(target, { recursive: true });
    fs.symlinkSync(copy, target);
    expect(refusal(() => loadRun(run.location))).toMatch(/is a symbolic link|must be a (directory|regular file) \(not a link or special file\)/);
  });

  it("a symlink in a parent directory above the data root", () => {
    const run = makeRun();
    fs.symlinkSync(run.root, path.join(run.root, "link"));
    expect(refusal(() => loadRun({ ...run.location, dataRoot: path.join(run.root, "link", "data") }))).toContain(`${path.join(run.root, "link")}: is a symbolic link`);
  });

  it("the data root itself is a symlink", () => {
    const run = makeRun();
    fs.symlinkSync(run.dataRoot, path.join(run.root, "data-link"));
    expect(refusal(() => loadRun({ ...run.location, dataRoot: path.join(run.root, "data-link") }))).toContain("data-link: is a symbolic link");
  });
});

describe("special files, sizes and encodings", () => {
  it("a FIFO in place of a source is refused promptly (child process with a timeout, so a regression can't hang the suite)", () => {
    const run = makeRun();
    const fifo = path.join(run.sourcesDir, run.manifest.sources[0].file);
    fs.rmSync(fifo);
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const script = path.join(run.root, "probe.mts");
    fs.writeFileSync(script, `import { loadRun } from ${JSON.stringify(path.join(REPO, "src/research-pipeline/local-files.ts"))};
try { loadRun(${JSON.stringify(run.location)}); console.log("LOADED"); } catch (e) { console.log("REFUSED " + e.reasons.join(" | ")); }\n`);
    const r = spawnSync(path.join(REPO, "node_modules/.bin/tsx"), [script], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: run.root } });
    expect(r.error, "loading blocked until the timeout").toBeUndefined();
    expect(r.stdout).toMatch(/^REFUSED .*must be a regular file \(not a link or special file\)/);
  }, 30_000);

  it("a socket in place of a source is refused", async () => {
    const run = makeRun();
    const target = path.join(run.sourcesDir, run.manifest.sources[0].file);
    fs.rmSync(target);
    // Unix socket paths are limited to about 108 bytes, so create it at a short path and hard-link it into place.
    const shortDir = fs.mkdtempSync("/tmp/rps-");
    roots.push(shortDir);
    const socketPath = path.join(shortDir, "s");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); // a local Unix socket file; no network
    try {
      fs.linkSync(socketPath, target);
      expect(fs.lstatSync(target).isSocket()).toBe(true);
      expect(refusal(() => loadRun(run.location))).toContain("must be a regular file (not a link or special file)");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("a directory in place of a source is refused", () => {
    const run = makeRun();
    const p = path.join(run.sourcesDir, run.manifest.sources[0].file);
    fs.rmSync(p);
    fs.mkdirSync(p);
    expect(refusal(() => loadRun(run.location))).toContain("must be a regular file");
  });

  it.each([
    ["a source", (r: Run) => setSource(r, 0, "a".repeat(MAX_SOURCE_BYTES + 1)), `the limit is ${MAX_SOURCE_BYTES}`],
    ["the opportunity file", (r: Run) => fs.writeFileSync(path.join(r.oppDir, "opportunity.json"), " ".repeat(MAX_OPPORTUNITY_BYTES + 1)), `the limit is ${MAX_OPPORTUNITY_BYTES}`],
    ["the manifest", (r: Run) => fs.writeFileSync(path.join(r.runDir, "manifest.json"), " ".repeat(MAX_MANIFEST_BYTES + 1)), `the limit is ${MAX_MANIFEST_BYTES}`],
    ["the workbook", (r: Run) => fs.writeFileSync(path.join(r.runDir, "workbook.json"), " ".repeat(MAX_WORKBOOK_BYTES + 1)), `the limit is ${MAX_WORKBOOK_BYTES}`],
  ])("an oversized %s is refused before it is read in full", (_label, mutate, message) => {
    const run = makeRun();
    mutate(run);
    expect(refusal(() => loadRun(run.location))).toContain(message);
  });

  it("a source exactly at the byte limit is accepted", () => {
    const run = makeRun();
    setSource(run, 0, "a".repeat(MAX_SOURCE_BYTES));
    expect(loadRun(run.location).sources[0].bytes).toBe(MAX_SOURCE_BYTES);
  });

  it("sources totalling more than the overall limit are refused", () => {
    const run = makeRun();
    const each = MAX_SOURCE_BYTES;
    const count = Math.floor(MAX_TOTAL_SOURCE_BYTES / each) + 1;
    const template = run.manifest.sources[0];
    run.manifest.sources = Array.from({ length: count }, (_, i) => ({ ...template, id: `big-${i}`, file: `big-${i}.txt`, derivedFromSnapshotIds: [] }));
    const text = "b".repeat(each);
    for (const f of fs.readdirSync(run.sourcesDir)) fs.rmSync(path.join(run.sourcesDir, f));
    for (const s of run.manifest.sources) { fs.writeFileSync(path.join(run.sourcesDir, s.file), text); s.sha256 = sha256(text); }
    // The workbook still cites the original source ids; keep the citations valid by also listing them.
    for (const s of validManifest().sources) { run.manifest.sources.unshift(s); fs.writeFileSync(path.join(run.sourcesDir, s.file), validReport().snapshots.find((x: any) => x.id === s.id)!.content); }
    run.writeManifest();
    expect(refusal(() => loadRun(run.location))).toContain(`sources total more than ${MAX_TOTAL_SOURCE_BYTES} bytes`);
  });

  it.each([
    ["an invalid byte", Uint8Array.from([0x61, 0xff, 0x62])],
    ["an overlong encoding", Uint8Array.from([0xc0, 0xaf])],
    ["an encoded surrogate", Uint8Array.from([0xed, 0xa0, 0x80])],
    ["a truncated sequence", Uint8Array.from([0x61, 0xe2, 0x82])],
  ])("a source with %s (not valid UTF-8) is refused", (_label, bytes) => {
    const run = makeRun();
    setSource(run, 0, bytes);
    expect(refusal(() => loadRun(run.location))).toContain("is not valid UTF-8");
  });

  it("a byte-order mark is refused (sources and JSON files)", () => {
    const run = makeRun();
    setSource(run, 0, Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]));
    expect(refusal(() => loadRun(run.location))).toContain("must not start with a byte-order mark");
  });

  it.each([["NUL", 0x00], ["ESC (ANSI)", 0x1b], ["DEL", 0x7f], ["CSI (C1)", 0x9b]])("a source containing %s is refused", (_label, code) => {
    const run = makeRun();
    setSource(run, 0, `before ${String.fromCharCode(code)} after`);
    expect(refusal(() => loadRun(run.location))).toContain("contains a control character");
  });

  it("source text keeps tabs, line breaks, CRLF and ordinary Unicode", () => {
    const run = makeRun();
    const text = "FICTIONAL.\tColumn\r\nLine two — café 東京 🐕\n";
    setSource(run, 0, text);
    expect(loadRun(run.location).sources[0].content).toBe(text);
  });
});

describe("hashes, missing files, unexpected entries and permissions", () => {
  it("a source whose bytes differ from the manifest hash is refused", () => {
    const run = makeRun();
    fs.appendFileSync(path.join(run.sourcesDir, run.manifest.sources[0].file), " ");
    expect(refusal(() => loadRun(run.location))).toContain("SHA-256 does not match the manifest");
  });

  it.each([
    ["the opportunity file", (r: Run) => fs.rmSync(path.join(r.oppDir, "opportunity.json")), "opportunity.json: is missing"],
    ["the workbook", (r: Run) => fs.rmSync(path.join(r.runDir, "workbook.json")), "workbook.json: is missing"],
    ["the sources directory", (r: Run) => fs.rmSync(r.sourcesDir, { recursive: true }), "sources: is missing"],
    ["a source file", (r: Run) => fs.rmSync(path.join(r.sourcesDir, r.manifest.sources[0].file)), `${"sources/"}`],
    ["the run directory", (r: Run) => fs.rmSync(r.runDir, { recursive: true }), "cannot be inspected (ENOENT)"],
  ])("missing %s is refused", (_label, mutate, message) => {
    const run = makeRun();
    mutate(run);
    expect(refusal(() => loadRun(run.location))).toContain(message);
  });

  it.each([
    ["an extra file among the sources", (r: Run) => fs.writeFileSync(path.join(r.sourcesDir, "extra.txt"), "x"), 'unexpected entry "extra.txt"'],
    ["a hidden file among the sources", (r: Run) => fs.writeFileSync(path.join(r.sourcesDir, ".DS_Store"), "x"), 'unexpected entry ".DS_Store"'],
    ["an extra directory in the run", (r: Run) => fs.mkdirSync(path.join(r.runDir, "out")), 'unexpected entry "out"'],
    ["an extra file in the opportunity directory", (r: Run) => fs.writeFileSync(path.join(r.oppDir, "notes.txt"), "x"), 'unexpected entry "notes.txt"'],
    ["a source file name with an unsupported extension", (r: Run) => fs.writeFileSync(path.join(r.sourcesDir, "report.pdf"), "x"), 'unexpected entry "report.pdf"'],
  ])("%s is refused", (_label, mutate, message) => {
    const run = makeRun();
    mutate(run);
    expect(refusal(() => loadRun(run.location))).toContain(message);
  });

  it.each([
    ["the run directory", (r: Run) => r.runDir],
    ["a source file", (r: Run) => path.join(r.sourcesDir, r.manifest.sources[0].file)],
    ["the data root", (r: Run) => r.dataRoot],
  ])("%s writable by others is refused", (_label, pick) => {
    const run = makeRun();
    const p = pick(run);
    fs.chmodSync(p, fs.statSync(p).mode | 0o002);
    expect(refusal(() => loadRun(run.location))).toContain("is writable by others");
  });

  it.skipIf(process.getuid?.() === 0)("an unreadable file is refused (permission error)", () => {
    const run = makeRun();
    fs.chmodSync(path.join(run.runDir, "workbook.json"), 0o000);
    expect(refusal(() => loadRun(run.location))).toContain("cannot be opened (EACCES)");
  });
});

describe("content and consistency use the step 2 parsers", () => {
  it("malformed JSON in the workbook is refused, naming the file", () => {
    const run = makeRun();
    fs.writeFileSync(path.join(run.runDir, "workbook.json"), "{not json");
    const text = refusal(() => loadRun(run.location));
    expect(text).toContain("workbook.json: invalid content");
    expect(text).toContain("workbook: is not valid JSON");
  });

  it("a duplicate key in the manifest is refused (step 2 scanner)", () => {
    const run = makeRun();
    fs.writeFileSync(path.join(run.runDir, "manifest.json"), JSON.stringify(run.manifest).replace('"version":1', '"version":1,"version":1'));
    expect(refusal(() => loadRun(run.location))).toContain("duplicate object key");
  });

  it("an opportunity id that differs from its folder is refused", () => {
    const run = makeRun();
    fs.writeFileSync(path.join(run.oppDir, "opportunity.json"), JSON.stringify({ ...validOpportunity(), id: "other-idea" }));
    expect(refusal(() => loadRun(run.location))).toContain('does not match the folder name "dog-walking"');
  });

  it("a run folder that differs from the manifest's run date is refused", () => {
    const run = makeRun();
    const renamed = path.join(path.dirname(run.runDir), "2026-10-16");
    fs.renameSync(run.runDir, renamed);
    expect(refusal(() => loadRun({ ...run.location, runId: "2026-10-16" }))).toContain('does not match the run folder "2026-10-16"');
  });

  it("an unsafe file name in the manifest is refused by the parser before any source is opened", () => {
    const run = makeRun();
    run.manifest.sources[0].file = "../escape.txt";
    run.writeManifest();
    const open = vi.spyOn(fs, "openSync");
    const text = refusal(() => loadRun(run.location));
    expect(text).toContain("manifest.sources[0].file");
    expect(open.mock.calls.map((c) => String(c[0])).some((p) => p.includes("escape"))).toBe(false);
  });
});

describe("simulated races (filesystem calls made to lie): the identity and bound checks hold", () => {
  const sourcePath = (run: Run) => path.join(run.sourcesDir, run.manifest.sources[0].file);

  it("a file swapped between inspection and opening (different inode at fstat) is refused", () => {
    const run = makeRun();
    const real = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const st = real(fd);
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: st.ino + 1 });
    }) as any);
    expect(refusal(() => loadRun(run.location))).toContain("changed between inspection and opening");
  });

  it("an opened descriptor that is not a regular file is refused", () => {
    const run = makeRun();
    const real = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const st = real(fd);
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isFile: () => false });
    }) as any);
    expect(refusal(() => loadRun(run.location))).toContain("is not a regular file");
  });

  it("a file that is larger than its reported size is still bounded by the actual bytes read", () => {
    const run = makeRun();
    setSource(run, 0, "c".repeat(MAX_SOURCE_BYTES + 10));
    const real = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const st = real(fd);
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 10 }); // lies about the size
    }) as any);
    const readSpy = vi.spyOn(fs, "readSync");
    expect(refusal(() => loadRun(run.location))).toContain(`grew beyond the limit of ${MAX_SOURCE_BYTES} bytes while being read`);
    const totalRequested = readSpy.mock.calls.filter((c) => true).reduce((sum, c) => sum + Number(c[3]), 0);
    expect(totalRequested).toBeLessThan(10 * (MAX_WORKBOOK_BYTES + 1)); // reads are bounded by limit + 1 per file
  });

  it("a directory or file whose identity changes before the final re-check is refused", () => {
    const run = makeRun();
    const real = fs.lstatSync;
    const seen = new Map<string, number>();
    const target = sourcePath(run);
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: string, ...rest: unknown[]) => {
      const st = (real as any)(p, ...rest);
      const n = (seen.get(p) ?? 0) + 1;
      seen.set(p, n);
      return p === target && n >= 2 ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: st.ino + 1 }) : st;
    }) as any);
    expect(refusal(() => loadRun(run.location))).toContain(`${target}: changed during loading`);
  });

  it("every file is opened read-only with O_NOFOLLOW and O_NONBLOCK", () => {
    const run = makeRun();
    const open = vi.spyOn(fs, "openSync");
    loadRun(run.location);
    const expected = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    expect(open.mock.calls.length).toBe(3 + run.manifest.sources.length);
    for (const call of open.mock.calls) expect(call[1]).toBe(expected);
  });

  it("an open failure (e.g. a permission error) is refused with its error code, never ignored", () => {
    const run = makeRun();
    vi.spyOn(fs, "openSync").mockImplementation((() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }) as any);
    expect(refusal(() => loadRun(run.location))).toContain("cannot be opened (EACCES)");
  });

  it("a read error is refused with its error code", () => {
    const run = makeRun();
    vi.spyOn(fs, "readSync").mockImplementation((() => { throw Object.assign(new Error("io"), { code: "EIO" }); }) as any);
    expect(refusal(() => loadRun(run.location))).toContain("could not be read (EIO)");
  });
});

describe("chain types and cross-file consistency", () => {
  it("a data root that is a regular file (not a directory) is refused by the chain check", () => {
    const run = makeRun();
    const fileRoot = path.join(run.root, "not-a-dir");
    fs.writeFileSync(fileRoot, "x");
    expect(refusal(() => loadRun({ ...run.location, dataRoot: fileRoot }))).toContain(`${fileRoot}: is not a directory`);
  });

  it("a manifest for a different opportunity is refused (run-input consistency)", () => {
    const run = makeRun();
    run.manifest.opportunityId = "other-idea";
    run.writeManifest();
    expect(refusal(() => loadRun(run.location))).toContain('manifest.opportunityId: must equal the opportunity id "dog-walking"');
  });

  it("a workbook citing a source that the manifest doesn't list is refused (run-input consistency)", () => {
    const run = makeRun();
    const w = validWorkbook();
    w.claims[0].citations[0].snapshotId = "unlisted-source";
    fs.writeFileSync(path.join(run.runDir, "workbook.json"), JSON.stringify(w));
    expect(refusal(() => loadRun(run.location))).toContain('"unlisted-source" is not a source in the manifest');
  });
});
