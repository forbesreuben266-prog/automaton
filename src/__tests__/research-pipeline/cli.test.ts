/**
 * Phase 1A step 6: offline research CLI. FICTIONAL inputs only, written to
 * temporary directories outside the repository and removed afterwards.
 */

import childProcess from "child_process";
import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleRun } from "../../research-pipeline/assemble.js";
import { BANNER, EXIT, MAX_ERROR_LINES, USAGE, formatRefusal, runCli, terminalSafe } from "../../research-pipeline/cli.js";
import { compareRuns } from "../../research-pipeline/history.js";
import { loadRun } from "../../research-pipeline/local-files.js";
import { DEMO_INITIAL, DEMO_LATER, DEMO_OPPORTUNITY, demoRuns, writeDemo, writeRun } from "./cli-demo.js";

const REPO = path.resolve(__dirname, "../../..");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rp-cli-")));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function cli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = runCli(argv, { out: (t) => { stdout += t; }, err: (t) => { stderr += t; } });
  return { code, stdout, stderr };
}
const assessArgs = (run = DEMO_INITIAL, dataRoot = root) =>
  ["assess", "--data-root", dataRoot, "--repo-root", REPO, "--opportunity", DEMO_OPPORTUNITY, "--run", run];
const compareArgs = (previous = DEMO_INITIAL, current = DEMO_LATER) =>
  ["compare", "--data-root", root, "--repo-root", REPO, "--opportunity", DEMO_OPPORTUNITY, "--previous", previous, "--current", current];
const location = (runId: string) => ({ dataRoot: root, repositoryRoot: REPO, opportunityId: DEMO_OPPORTUNITY, runId });
const runDir = (date: string) => path.join(root, DEMO_OPPORTUNITY, "runs", date);
/** Every reported line, checked for leaks. */
function expectSafeError(stderr: string) {
  expect(stderr).not.toContain(root);
  expect(stderr).not.toContain(REPO);
  expect(stderr).not.toMatch(/^\s+at /m); // no stack frames
  expect(stderr).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
}

describe("usage and argument validation", () => {
  it("prints usage for --help (exit 0)", () => {
    expect(cli("--help")).toEqual({ code: EXIT.ok, stdout: USAGE, stderr: "" });
    expect(cli("-h").code).toBe(EXIT.ok);
  });

  it.each([
    ["no command", [], "no command given"],
    ["an unknown command", ["delete"], "unknown command (expected assess or compare)"],
    ["an inherited object name as a command", ["toString"], "unknown command (expected assess or compare)"],
    ["--help combined with other arguments", ["--help", "assess"], "unknown command (expected assess or compare)"],
    ["an unknown option", ["assess", "--output", "x"], "unknown option --output for assess"],
    ["an option of the other command", ["assess", "--previous", "2026-10-15"], "unknown option --previous for assess"],
    ["a repeated option", ["assess", "--run", "a", "--run", "b"], "option --run is given more than once"],
    ["an option without a value", ["assess", "--run"], "option --run needs a value"],
    ["an option followed by another option", ["assess", "--run", "--opportunity", "x"], "option --run needs a value"],
    ["a positional argument", ["assess", "/tmp/somewhere"], "argument 2 is not an option (options look like --name value)"],
    ["a missing required option", ["assess", "--run", "2026-10-15"], "missing option --data-root"],
    ["an over-long argument", ["assess", "--run", "x".repeat(5_000)], "arguments must be text of at most 4096 characters"],
  ])("refuses %s with a usage error (exit 2)", (_label, argv, message) => {
    const r = cli(...(argv as string[]));
    expect(r.code).toBe(EXIT.usage);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`Usage error: ${message}\n\n${USAGE}`);
  });

  it("never echoes argument values in usage errors", () => {
    const r = cli("assess", `/secret/${"\u001b[2J"}path`, "--run", "x");
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).not.toContain("secret");
    expect(r.stderr).not.toContain("\u001b");
  });
});

describe("assess", () => {
  beforeEach(() => writeDemo(root));

  it("prints the banner and the validated, assembled report (exit 0)", () => {
    const r = cli(...assessArgs());
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(terminalSafe(BANNER + assembleRun(loadRun(location(DEMO_INITIAL))).markdown));
    expect(r.stdout.startsWith(BANNER)).toBe(true);
    expect(r.stdout).toContain("Operator assessments (scores, gate marks, negative findings, contradictions) are not independently verified facts.");
    expect(r.stdout).toContain("Financial figures are projections from assumptions, not established business results.");
    expect(r.stdout).toContain("# Research assessment (Phase 1A, evidence-aware)");
    expect(r.stdout).toContain("## A3. Evidence ledger");
  });

  it("is deterministic", () => {
    expect(cli(...assessArgs()).stdout).toBe(cli(...assessArgs()).stdout);
  });

  it("neutralises invisible formatting characters that pass the parsers and Markdown escaping", () => {
    const { initial } = demoRuns();
    initial.workbook.claims.find((c: any) => c.id === "c-customer").statement = "Target customers\u2060 are full-time\u00ad workers.";
    fs.rmSync(path.join(root, DEMO_OPPORTUNITY), { recursive: true });
    writeRun(root, initial);
    const r = cli(...assessArgs());
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("Target customers\\u{2060} are full-time\\u{00AD} workers.");
    expect(r.stdout).not.toMatch(/[\u00ad\u2060]/);
  });

  it("refuses an invalid manifest (exit 1) with a bounded, path-redacted message", () => {
    fs.writeFileSync(path.join(runDir(DEMO_INITIAL), "manifest.json"), "{ not json");
    const r = cli(...assessArgs());
    expect(r.code).toBe(EXIT.refused);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`- <data-root>/${DEMO_OPPORTUNITY}/runs/${DEMO_INITIAL}/manifest.json: invalid content`);
    expectSafeError(r.stderr);
  });

  it("refuses an invalid workbook (exit 1)", () => {
    const { initial } = demoRuns();
    initial.workbook.sections.summary.push("no-such-claim");
    fs.rmSync(path.join(root, DEMO_OPPORTUNITY), { recursive: true });
    writeRun(root, initial);
    const r = cli(...assessArgs());
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain('unknown claim "no-such-claim"');
    expectSafeError(r.stderr);
  });

  it("refuses a missing run and an unsafe opportunity id (exit 1)", () => {
    const missing = cli(...assessArgs("2026-10-16"));
    expect(missing.code).toBe(EXIT.refused);
    expect(missing.stderr).toBe(`Refused:\n- <data-root>/${DEMO_OPPORTUNITY}/runs/2026-10-16: cannot be inspected (ENOENT)\n`);
    const unsafe = cli("assess", "--data-root", root, "--repo-root", REPO, "--opportunity", "../etc", "--run", DEMO_INITIAL);
    expect(unsafe.code).toBe(EXIT.refused);
    expect(unsafe.stderr).toContain("opportunityId: must be a plain lower-case name");
  });

  it.each([
    ["a relative data root", "relative/data", "dataRoot: must be a normalized absolute path"],
    ["a data root with a .. component", "/tmp/../etc", "dataRoot: must be a normalized absolute path"],
  ])("refuses %s before reading anything (exit 1)", (_label, dataRoot, message) => {
    const r = cli(...assessArgs(DEMO_INITIAL, dataRoot));
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain(message);
  });

  it("refuses a data root inside the repository (overlapping roots, exit 1)", () => {
    const r = cli(...assessArgs(DEMO_INITIAL, path.join(REPO, "research-data")));
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toBe("Refused:\n- dataRoot: must be outside the repository (and must not contain it)\n");
  });

  it("refuses a symlinked data root and a symlinked run directory (exit 1)", () => {
    const link = path.join(path.dirname(root), `${path.basename(root)}-link`);
    fs.symlinkSync(root, link);
    try {
      const r = cli(...assessArgs(DEMO_INITIAL, link));
      expect(r.code).toBe(EXIT.refused);
      expect(r.stderr).toContain("is a symbolic link");
      expectSafeError(r.stderr);
    } finally {
      fs.unlinkSync(link);
    }
    fs.renameSync(runDir(DEMO_INITIAL), path.join(root, "moved"));
    fs.symlinkSync(path.join(root, "moved"), runDir(DEMO_INITIAL));
    const r2 = cli(...assessArgs());
    expect(r2.code).toBe(EXIT.refused);
    expect(r2.stderr).toContain(`<data-root>/${DEMO_OPPORTUNITY}/runs/${DEMO_INITIAL}: is a symbolic link`);
  });

  it("shows terminal control characters from file names in a visible, inert form", () => {
    fs.writeFileSync(path.join(runDir(DEMO_INITIAL), "sources", "evil\u001b[2J\u0007‮.txt"), "x");
    const r = cli(...assessArgs());
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain('unexpected entry "evil\\u{001B}[2J\\u{0007}\\u{202E}.txt"');
    expectSafeError(r.stderr);
    expect(r.stderr).not.toContain("‮");
  });

  it("bounds long error lists", () => {
    const { initial } = demoRuns();
    for (let i = 0; i < 150; i++) initial.workbook.claims.push({ id: `BAD CLAIM ${i}`, type: "fact", statement: "x", citations: [] });
    fs.rmSync(path.join(root, DEMO_OPPORTUNITY), { recursive: true });
    writeRun(root, initial);
    const r = cli(...assessArgs());
    expect(r.code).toBe(EXIT.refused);
    const lines = r.stderr.trimEnd().split("\n");
    expect(lines.length).toBe(1 + MAX_ERROR_LINES + 1);
    expect(lines[lines.length - 1]).toMatch(/^- \.\.\. and \d+ more$/);
  });
});

describe("compare", () => {
  beforeEach(() => writeDemo(root));

  it("prints the Step 5 comparison of two independently validated runs (exit 0)", () => {
    const r = cli(...compareArgs());
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(terminalSafe(BANNER + compareRuns(loadRun(location(DEMO_INITIAL)), loadRun(location(DEMO_LATER))).markdown));
    expect(r.stdout).toContain("- source:neighbourhood-poll (added)");
    expect(r.stdout).toContain("- assumption:cac (changed)");
    expect(r.stdout).toContain("## Revisit triggers (suggestions to reassess; they authorize no action)");
    expect(r.stdout).toContain("**Opportunity retained.**");
  });

  it("revisit triggers authorize nothing and the opportunity is retained", () => {
    const { comparison } = compareRuns(loadRun(location(DEMO_INITIAL)), loadRun(location(DEMO_LATER)));
    expect(comparison.revisitTriggers.map((t) => t.triggerId)).toEqual(["revisit-new-evidence", "revisit-financial-assumptions"]);
    expect(comparison.revisitTriggers.every((t) => t.authorizes === "nothing")).toBe(true);
    expect(comparison.retention).toBe("retained");
  });

  it("refuses reverse order and duplicate dates (exit 1)", () => {
    expect(cli(...compareArgs(DEMO_LATER, DEMO_INITIAL))).toEqual({
      code: EXIT.refused, stdout: "", stderr: `Refused:\n- the current run (${DEMO_INITIAL}) is dated before the previous run (${DEMO_LATER})\n`,
    });
    expect(cli(...compareArgs(DEMO_INITIAL, DEMO_INITIAL)).stderr).toContain("dates must be strictly increasing");
  });

  it("refuses when either run is invalid (exit 1)", () => {
    fs.writeFileSync(path.join(runDir(DEMO_LATER), "workbook.json"), "[]");
    const r = cli(...compareArgs());
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toContain(`<data-root>/${DEMO_OPPORTUNITY}/runs/${DEMO_LATER}/workbook.json: invalid content`);
    expectSafeError(r.stderr);
  });
});

describe("safety", () => {
  beforeEach(() => writeDemo(root));

  it("writes nothing, opens files read-only, and makes no network, process or environment call", () => {
    const calls: string[] = [];
    const block = (obj: any, name: string, label: string) => {
      if (typeof obj[name] === "function") vi.spyOn(obj, name).mockImplementation(((..._a: unknown[]) => { calls.push(label); throw new Error(`${label} called`); }) as any);
    };
    for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "renameSync", "unlinkSync", "copyFileSync", "symlinkSync", "linkSync",
      "chmodSync", "chownSync", "truncateSync", "writeSync", "utimesSync", "writeFile", "mkdir", "rm"]) block(fs, name, `fs.${name}`);
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) block(childProcess, name, `child_process.${name}`);
    block(net, "connect", "net.connect"); block(net, "createConnection", "net.createConnection");
    block(http, "request", "http.request"); block(https, "request", "https.request"); block(globalThis, "fetch", "fetch");
    const realOpen = fs.openSync;
    const flags: number[] = [];
    vi.spyOn(fs, "openSync").mockImplementation(((file: any, f: any, ...rest: any[]) => { flags.push(f); return (realOpen as any)(file, f, ...rest); }) as any);
    const realEnv = process.env;
    process.env = new Proxy(realEnv, { get: (t, k) => { if (typeof k === "string") calls.push(`env.${k}`); return Reflect.get(t, k); } }) as NodeJS.ProcessEnv;
    let codes: number[];
    try {
      codes = [cli(...assessArgs()).code, cli(...compareArgs()).code];
    } finally {
      process.env = realEnv;
    }
    expect(codes).toEqual([EXIT.ok, EXIT.ok]);
    expect(calls).toEqual([]);
    const readOnly = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f === readOnly)).toBe(true);
  });

  it("leaves the inputs unchanged", () => {
    const snapshot = () => {
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const p = path.join(dir, e.name);
          const st = fs.lstatSync(p);
          out.push(`${p} ${st.mode} ${st.size} ${st.mtimeMs}`);
          if (e.isDirectory()) walk(p);
          else out.push(fs.readFileSync(p, "utf8"));
        }
      };
      walk(root);
      return out.join("\n");
    };
    const before = snapshot();
    cli(...assessArgs());
    cli(...compareArgs());
    expect(snapshot()).toBe(before);
  });

  it("terminalSafe replaces control, bidi and invisible characters with a visible form, keeping line feeds and text", () => {
    expect(terminalSafe("a\u001b[31mred\u009b2J\u0007\r\tb‮c​d﻿e f\nok £15 — ≥")).toBe(
      "a\\u{001B}[31mred\\u{009B}2J\\u{0007}\\u{000D}\\u{0009}b\\u{202E}c\\u{200B}d\\u{FEFF}e\\u{2028}f\nok £15 — ≥");
  });

  it("formatRefusal redacts roots and other absolute paths, bounds lines and keeps URLs readable", () => {
    const text = formatRefusal([`${root}/dog-walking: x`, `${REPO}/src: y`, "/etc/passwd: z", "see https://example.org/a/b", "v".repeat(400)], [root, REPO]);
    expect(text).toBe("Refused:\n- <data-root>/dog-walking: x\n- <repo-root>/src: y\n- <path>: z\n- see https://example.org/a/b\n" +
      `- ${"v".repeat(300)}...\n`);
  });

  it("an unexpected internal error gives exit 3 with details withheld", () => {
    let stderr = "";
    const code = runCli(assessArgs(), { out: () => { throw new Error(`boom at ${root}`); }, err: (t) => { stderr += t; } });
    expect(code).toBe(EXIT.internal);
    expect(stderr).toBe("Internal error (details withheld).\n");
  });
});

const run = (...args: string[]) => childProcess.spawnSync(TSX, args, { cwd: REPO, encoding: "utf8", timeout: 60_000,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: os.tmpdir(), NO_UPDATE_NOTIFIER: "1" } });
const DEMO_HELPER = "src/__tests__/research-pipeline/cli-demo.ts";

describe("fictional demo helper: destination checks (subprocess)", () => {
  /** Recursive listing with contents, to show nothing was written. */
  const listing = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? [`${p}/`, ...listing(p)] : [`${p} ${fs.lstatSync(p).isSymbolicLink() ? "->" : fs.readFileSync(p, "utf8")}`];
  });
  function expectRefused(result: ReturnType<typeof run>, reason: string) {
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`Refused: ${reason}.\nUsage: cli-demo.ts <existing empty absolute directory outside the repository>\n`);
    expect(result.stderr).not.toMatch(/^\s+at |node:fs|Error/m); // no stack trace
    expect(result.stderr).not.toContain(root);
  }
  /** A temporary empty directory inside the repository (created for the test, removed afterwards). */
  function withRepoTemp(fn: (dir: string) => void) {
    const dir = fs.mkdtempSync(path.join(REPO, ".rp-demo-test-"));
    try {
      fn(dir);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("refuses a non-empty destination and leaves its existing files unchanged", () => {
    fs.writeFileSync(path.join(root, "keep.txt"), "operator file");
    fs.mkdirSync(path.join(root, DEMO_OPPORTUNITY));
    fs.writeFileSync(path.join(root, DEMO_OPPORTUNITY, "opportunity.json"), "existing");
    const before = listing(root);
    expectRefused(run(DEMO_HELPER, root), "the destination is not empty");
    expect(listing(root)).toEqual(before);
  });

  it("refuses an empty destination inside the repository", () => {
    withRepoTemp((dir) => expectRefused(run(DEMO_HELPER, dir), "the destination is inside the repository (or contains it)"));
  });

  it("refuses a symlink pointing into the repository, and a path under a symlinked ancestor that resolves into it", () => {
    withRepoTemp((dir) => {
      fs.mkdirSync(path.join(dir, "sub"));
      const link = path.join(root, "link-into-repo");
      fs.symlinkSync(dir, link);
      expectRefused(run(DEMO_HELPER, link), "the destination must not be a symbolic link");
      expectRefused(run(DEMO_HELPER, path.join(link, "sub")), "the destination is inside the repository (or contains it)");
      expect(fs.readdirSync(path.join(dir, "sub"))).toEqual([]);
      fs.rmdirSync(path.join(dir, "sub"));
    });
  });

  it("refuses a relative destination, a missing one, a regular file and extra arguments", () => {
    expectRefused(run(DEMO_HELPER, "relative/dir"), "the destination must be an absolute path");
    expectRefused(run(DEMO_HELPER, path.join(root, "missing")), "the destination does not exist or cannot be inspected");
    fs.writeFileSync(path.join(root, "file.txt"), "not a directory");
    expectRefused(run(DEMO_HELPER, path.join(root, "file.txt")), "the destination is not a directory");
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("not a directory");
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    expectRefused(run(DEMO_HELPER, empty, empty), "expected exactly one destination argument");
    expect(fs.readdirSync(empty)).toEqual([]);
    expectRefused(run(DEMO_HELPER), "expected exactly one destination argument");
  });

  it("creates files exclusively: writing over an existing demonstration file fails and leaves it unchanged", () => {
    const { initial } = demoRuns();
    writeRun(root, initial);
    const manifest = path.join(runDir(DEMO_INITIAL), "manifest.json");
    fs.writeFileSync(manifest, "operator edit");
    expect(() => writeRun(root, initial, false)).toThrow(/EEXIST/);
    expect(fs.readFileSync(manifest, "utf8")).toBe("operator edit");
  });
});

describe("end-to-end fictional demonstration (operator-invoked commands)", () => {

  it("writes the fictional runs, then assess and compare give the documented results and exit codes", () => {
    const demo = run(DEMO_HELPER, root);
    expect(demo.status).toBe(0);
    expect(demo.stdout).toBe(`Wrote fictional demonstration runs ${DEMO_INITIAL} and ${DEMO_LATER} for "${DEMO_OPPORTUNITY}".\n`);
    const main = "src/research-pipeline/cli-main.ts";
    const assess = run(main, ...assessArgs().slice(0));
    expect([assess.status, assess.stderr]).toEqual([0, ""]);
    expect(assess.stdout).toContain("**Research assessment: SUPPORTED FOR CONSIDERATION (preliminary screening)");
    expect(assess.stdout).toContain("FICTIONAL DEMONSTRATION: invented data; not real demand, prices, profitability or market conditions.");
    const compare = run(main, ...compareArgs());
    expect([compare.status, compare.stderr]).toEqual([0, ""]);
    expect(compare.stdout).toContain("- revisit-financial-assumptions:");
    expect(run(main, ...compareArgs(DEMO_LATER, DEMO_INITIAL)).status).toBe(1);
    expect(run(main, "assess").status).toBe(2);
  }, 120_000);
});
