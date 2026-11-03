/**
 * U2: deterministic offline smoke test of the documented demonstration.
 * Writes the FICTIONAL demonstration into a temporary directory outside the
 * repository (with the runnable demo writer), then runs every documented
 * command through the unified CLI and checks meaningful outputs. Removed
 * afterwards. No network, models, Docker or real data.
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT, runResearchCli } from "../../research-cli/cli.js";
import { PaperSession, datasetSha256, parseBacktestConfigText, parseDatasetText } from "../../trading-research/index.js";
import { DEMO_RUNS } from "./demo.js";

const REPO = path.resolve(__dirname, "../../..");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
let root: string;
const subprocess = (...args: string[]) => childProcess.spawnSync(TSX, args, {
  cwd: REPO, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: os.tmpdir(), NO_UPDATE_NOTIFIER: "1" },
});

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rp-demo-")));
  fs.chmodSync(root, 0o755);
  const r = subprocess("src/__tests__/research-cli/demo.ts", root);
  expect(r.status, r.stderr).toBe(0);
}, 120_000);
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

function cli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = runResearchCli(argv, { out: (t) => { stdout += t; }, err: (t) => { stderr += t; } });
  return { code, stdout, stderr };
}
const args = (...rest: string[]) => [rest[0], ...(rest[0] === "trading" ? [rest[1]] : []), "--data-root", root, "--repo-root", REPO, ...rest.slice(rest[0] === "trading" ? 2 : 1)];
/** The fills and rejected-order lines of a report (identical between a backtest and a paper replay of the same data). */
const executionLines = (md: string) => {
  const lines = md.slice(md.indexOf("### Fills")).split("\n");
  const end = lines.findIndex((l) => l !== "" && !l.startsWith("### ") && !l.startsWith("- "));
  return lines.slice(0, end).join("\n");
};
const line = (md: string, prefix: string) => md.split("\n").find((l) => l.startsWith(prefix));

describe("the demonstration writer", () => {
  it("wrote exactly the documented files and refuses to write into a non-empty directory", () => {
    expect(fs.readdirSync(root).sort()).toEqual(["dog-walking", "fict-eurusd.json", "fict-uk.json", "fict-us-trend.json", "run-eurusd.json", "run-uk.json", "run-us-ma.json"]);
    const again = subprocess("src/__tests__/research-cli/demo.ts", root);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain("Refused: the destination is not empty.");
  }, 60_000);
});

describe("business research example (assess, compare)", () => {
  it("assess reports the research assessment for the first run", () => {
    const r = cli(...args("assess", "--opportunity", "dog-walking", "--run", "2026-10-15"));
    expect([r.code, r.stderr]).toEqual([EXIT.ok, ""]);
    expect(r.stdout).toContain("**Research assessment: SUPPORTED FOR CONSIDERATION (preliminary screening)");
    expect(r.stdout).toContain("FICTIONAL DEMONSTRATION: invented data");
    expect(r.stdout).toContain("## A3. Evidence ledger");
  });

  it("compare finds the new source, the changed assumption and the revisit triggers", () => {
    const r = cli(...args("compare", "--opportunity", "dog-walking", "--previous", "2026-10-15", "--current", "2026-10-20"));
    expect([r.code, r.stderr]).toEqual([EXIT.ok, ""]);
    for (const text of ["- source:neighbourhood-poll (added)", "- assumption:cac (changed)", "- revisit-new-evidence:", "- revisit-financial-assumptions:", "**Opportunity retained.**"]) {
      expect(r.stdout).toContain(text);
    }
  });
});

describe("trading research example (validate, backtest, paper)", () => {
  it.each(["fict-us-trend.json", "fict-uk.json", "fict-eurusd.json"])("validate %s reports the dataset's SHA-256", (file) => {
    const r = cli(...args("trading", "validate", "--dataset", file));
    expect([r.code, r.stderr]).toEqual([EXIT.ok, ""]);
    expect(r.stdout).toContain(`SHA-256 of the validated dataset: ${datasetSha256(parseDatasetText(fs.readFileSync(path.join(root, file), "utf8")))}`);
    expect(r.stdout).toContain("Status: **valid**");
  });

  const runs: Array<[string, keyof typeof DEMO_RUNS, string]> = [
    ["fict-us-trend.json", "run-us-ma.json", "buy 50 at 110.5321 USD"], // open 110.50 x 1.0002 + 0.01 half spread
    ["fict-uk.json", "run-uk.json", "buy 394 at 250.75 GBX"], // 250p + 1.5p/2; 394 units (as in the T2 hand check)
    ["fict-eurusd.json", "run-eurusd.json", "buy 10000 at 1.10017 USD"], // 1.10000 x 1.0001 + 0.00006
  ];
  it.each(runs)("backtest and paper replay of %s with %s give the same fills and final equity", (file, config, firstFill) => {
    const bt = cli(...args("trading", "backtest", "--dataset", file, "--config", config));
    const paper = cli(...args("trading", "paper", "--dataset", file, "--config", config));
    expect([bt.code, paper.code, bt.stderr, paper.stderr]).toEqual([0, 0, "", ""]);
    expect(bt.stdout).toContain(firstFill);
    expect(executionLines(paper.stdout)).toBe(executionLines(bt.stdout));
    expect(line(paper.stdout, "| Final equity")).toBe(line(bt.stdout, "| Final equity"));
    expect(line(paper.stdout, "| Fees / spread cost")).toBe(line(bt.stdout, "| Fees / spread cost"));
    // The reported ledger head is the one an independent replay of the same files produces.
    const ds = parseDatasetText(fs.readFileSync(path.join(root, file), "utf8"));
    const head = PaperSession.replay(ds, parseBacktestConfigText(fs.readFileSync(path.join(root, config), "utf8"), ds)).ledgerHead;
    expect(paper.stdout).toContain(`final hash ${head}`);
  });

  it("the moving-average example trades in and out (hand-checked fills)", () => {
    const r = cli(...args("trading", "backtest", "--dataset", "fict-us-trend.json", "--config", "run-us-ma.json"));
    expect(executionLines(r.stdout).split("### Rejected orders")[0].split("\n").filter((l) => l.startsWith("- ")).map((l) => l.split(" (")[0])).toEqual([
      "- 2026-03-09T21:00:00Z buy 50 at 110.5321 USD", "- 2026-03-15T21:00:00Z sell 50 at 108.9682 USD", "- 2026-03-24T21:00:00Z buy 50 at 103.0306 USD",
    ]);
    expect(line(r.stdout, "| Final equity")).toBe("| Final equity (open position at last close, mid) | 10267.275 USD |");
  });

  it("every documented command is deterministic", () => {
    for (const argv of [args("trading", "paper", "--dataset", "fict-uk.json", "--config", "run-uk.json"), args("compare", "--opportunity", "dog-walking", "--previous", "2026-10-15", "--current", "2026-10-20")]) {
      expect(cli(...argv).stdout).toBe(cli(...argv).stdout);
    }
  });

  it("the entry point runs the documented commands with the documented exit codes", () => {
    const ok = subprocess("src/research-cli/main.ts", ...args("trading", "validate", "--dataset", "fict-uk.json"));
    expect([ok.status, ok.stderr]).toEqual([0, ""]);
    expect(subprocess("src/research-cli/main.ts", ...args("trading", "backtest", "--dataset", "fict-uk.json", "--strategy", "buy_and_hold")).status).toBe(2);
    expect(subprocess("src/research-cli/main.ts", ...args("trading", "validate", "--dataset", "missing.json")).status).toBe(1);
  }, 120_000);
});
