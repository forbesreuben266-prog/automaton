/**
 * R2: `import review` through the unified CLI, with FICTIONAL manifests and
 * content written to a temporary data root outside the repository (removed
 * afterwards). Checks the read-only, restricted file handling it reuses from
 * the trading-input loader, and the exit codes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, runResearchCli } from "../../research-cli/cli.js";
import { businessBundle, importManifest, marketRecord } from "../research-readiness/fixtures.js";

const REPO = path.resolve(__dirname, "../../..");
let root: string;
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const write = (name: string, text: string | Uint8Array) => fs.writeFileSync(path.join(root, name), text, { mode: 0o644 });
function cli(...extra: string[]) {
  let stdout = "";
  let stderr = "";
  const code = runResearchCli(["import", "review", "--data-root", root, "--repo-root", REPO, ...extra], { out: (t) => { stdout += t; }, err: (t) => { stderr += t; } });
  return { code, stdout, stderr };
}
function stage(content: string, dataType: "business_evidence" | "market_data", edit: (m: any) => void = () => {}) {
  write("content.json", content);
  const m = importManifest(content, dataType);
  edit(m);
  write("manifest.json", json(m));
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rp-import-")));
  fs.chmodSync(root, 0o755);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("import review", () => {
  it.each([["business_evidence", () => json(businessBundle())], ["market_data", () => json(marketRecord("fx"))]] as const)("%s: prints the review and exits 0 while awaiting approval", (dataType, content) => {
    stage(content(), dataType);
    const r = cli("--manifest", "manifest.json");
    expect([r.code, r.stderr]).toEqual([EXIT.ok, ""]);
    expect(r.stdout.startsWith("Offline import quarantine review -- FICTIONAL data only.")).toBe(true);
    expect(r.stdout).toContain("**Quarantine state: AWAITING APPROVAL.** Approved for real-world use: **no**.");
  });

  it("a rejected import is still reported in full, with exit code 1", () => {
    stage(json(businessBundle()), "business_evidence", (m) => { m.content.sha256 = "0".repeat(64); });
    const r = cli("--manifest", "manifest.json");
    expect([r.code, r.stderr]).toEqual([EXIT.refused, ""]);
    expect(r.stdout).toContain("## Rejection reasons");
    expect(r.stdout).toContain("content: SHA\\-256 does not match the manifest");
  });

  it("is read-only: the inputs are unchanged and nothing is created", () => {
    stage(json(marketRecord("uk")), "market_data");
    const before = fs.readdirSync(root).map((f) => [f, fs.readFileSync(path.join(root, f), "utf8"), fs.statSync(path.join(root, f)).mtimeMs, fs.statSync(path.join(root, f)).mode]);
    expect(cli("--manifest", "manifest.json").code).toBe(EXIT.ok);
    const after = fs.readdirSync(root).map((f) => [f, fs.readFileSync(path.join(root, f), "utf8"), fs.statSync(path.join(root, f)).mtimeMs, fs.statSync(path.join(root, f)).mode]);
    expect(after).toEqual(before);
  });
});

describe("restricted local file handling (refusals, exit 1, paths redacted)", () => {
  const refused = (r: ReturnType<typeof cli>, message: string) => {
    expect([r.code, r.stdout]).toEqual([EXIT.refused, ""]);
    expect(r.stderr).toContain(message);
    expect(r.stderr).not.toContain(root);
  };

  it("refuses traversal and non-plain names for the manifest", () => {
    stage(json(businessBundle()), "business_evidence");
    for (const name of ["../manifest.json", "sub/manifest.json", ".manifest.json", "Manifest.JSON", "manifest.txt"]) {
      refused(cli("--manifest", name), "--manifest: must be a plain lower-case file name ending in .json, directly inside the data root");
    }
  });

  it("refuses a symbolic-link manifest or content file", () => {
    stage(json(businessBundle()), "business_evidence");
    fs.symlinkSync(path.join(root, "manifest.json"), path.join(root, "link.json"));
    refused(cli("--manifest", "link.json"), "<data-root>/link.json: is a symbolic link");
    fs.renameSync(path.join(root, "content.json"), path.join(root, "real.json"));
    fs.symlinkSync(path.join(root, "real.json"), path.join(root, "content.json"));
    refused(cli("--manifest", "manifest.json"), "<data-root>/content.json: is a symbolic link");
  });

  it("refuses a missing content file, and a manifest that names itself", () => {
    stage(json(businessBundle()), "business_evidence");
    fs.unlinkSync(path.join(root, "content.json"));
    refused(cli("--manifest", "manifest.json"), "<data-root>/content.json: cannot be inspected (ENOENT)");
    write("self.json", json(importManifest("{}", "business_evidence", "self.json")));
    refused(cli("--manifest", "self.json"), "manifest.content.file: must name a different file from the manifest");
  });

  it("refuses unsafe permissions and a data root inside the repository", () => {
    stage(json(businessBundle()), "business_evidence");
    fs.chmodSync(root, 0o777);
    refused(cli("--manifest", "manifest.json"), "<data-root>: is writable by others");
    fs.chmodSync(root, 0o755);
    const r = runResearchCli(["import", "review", "--data-root", path.join(REPO, "docs"), "--repo-root", REPO, "--manifest", "manifest.json"], { out: () => {}, err: (t) => { expect(t).toContain("data root: must be outside the repository"); } });
    expect(r).toBe(EXIT.refused);
  });

  it("refuses oversized files and malformed encodings", () => {
    write("manifest.json", `${" ".repeat(100_001)}{}`);
    refused(cli("--manifest", "manifest.json"), "<data-root>/manifest.json: is 100003 bytes; the limit is 100000");
    stage(json(businessBundle()), "business_evidence");
    write("content.json", new Uint8Array([0x7b, 0xff, 0x7d]));
    refused(cli("--manifest", "manifest.json"), "<data-root>/content.json: is not valid UTF-8");
    write("content.json", new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
    refused(cli("--manifest", "manifest.json"), "<data-root>/content.json: must not start with a byte-order mark");
  });

  it("a manifest naming a path outside the data root is rejected without reading anything else", () => {
    stage(json(businessBundle()), "business_evidence", (m) => { m.content.file = "../etc-passwd.json"; });
    const r = cli("--manifest", "manifest.json");
    expect([r.code, r.stderr]).toEqual([EXIT.refused, ""]);
    expect(r.stdout).toContain("manifest.content.file: must be a plain lower\\-case file name ending in .json \\(no directories\\)");
    expect(r.stdout).toContain("- Lifecycle: received -> rejected");
  });
});

describe("usage errors (exit 2)", () => {
  it.each([
    [[], "unknown import command (expected review)"],
    [["approve"], "unknown import command (expected review)"],
    [["review", "--data-root", "/x", "--repo-root", "/y"], "missing option --manifest"],
    [["review", "--data-root", "/x", "--repo-root", "/y", "--manifest", "m.json", "--dataset", "d.json"], "unknown option --dataset for import review"],
  ])("import %j", (rest, message) => {
    let stderr = "";
    const code = runResearchCli(["import", ...rest], { out: () => {}, err: (t) => { stderr += t; } });
    expect(code).toBe(EXIT.usage);
    expect(stderr.split("\n")[0]).toBe(`Usage error: ${message}`);
  });
});
