/**
 * Static checks of the (not built) canary-probe Dockerfile against the
 * sandbox specification and the preflight's inspect rules. Nothing is built,
 * pulled or run; files are only read.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SANDBOX_SPEC } from "../../research-sandbox/index.js";
import { PROBE_COMMAND } from "./fixtures.js";

const REPO = path.resolve(__dirname, "../../..");
const DIR = path.join(REPO, "deploy", "research-sandbox");
const DOCKERFILE = fs.readFileSync(path.join(DIR, "Dockerfile.canary"), "utf8");
/** Instructions without comments or blank lines (the file uses no line continuations). */
const instructions = DOCKERFILE.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));

describe("canary-probe Dockerfile (not built)", () => {
  it("contains exactly the reviewed instructions", () => {
    expect(instructions).toEqual([
      "ARG NODE_BASE_DIGEST",
      `FROM ${SANDBOX_SPEC.image.repository}:${SANDBOX_SPEC.image.tag}@\${NODE_BASE_DIGEST}`,
      "WORKDIR /app",
      "COPY --chown=0:0 --chmod=0444 package.json canary-probe.js canary.js /app/",
    ]);
  });

  it("pins the base by a digest supplied at build time, with no default and no invented digest", () => {
    expect(instructions.some((i) => /NODE_BASE_DIGEST=/.test(i))).toBe(false); // no default value (the comments explain the build argument)
    expect(DOCKERFILE).not.toMatch(/sha256:[0-9a-f]{64}/);
    expect(SANDBOX_SPEC.image.digest).toBeNull(); // still unrecorded: the image can't be built or trusted yet
  });

  it("changes nothing the preflight's inspect checks pin (env, labels, entrypoint, user, healthcheck) and installs nothing", () => {
    for (const keyword of ["ENV", "LABEL", "ENTRYPOINT", "CMD", "USER", "RUN", "ADD", "EXPOSE", "VOLUME", "HEALTHCHECK", "ONBUILD", "SHELL", "STOPSIGNAL", "MAINTAINER"]) {
      expect(instructions.some((i) => i.toUpperCase().startsWith(`${keyword} `)), keyword).toBe(false);
    }
    expect(instructions.filter((i) => i.startsWith("ARG ")).length).toBe(1); // no build argument can reach the runtime environment
  });

  it("matches the preflight's probe command and working directory", () => {
    const workdir = instructions.find((i) => i.startsWith("WORKDIR "))!.slice("WORKDIR ".length);
    expect(workdir).toBe("/app"); // inspect.ts: Config.WorkingDir must be /app
    expect(PROBE_COMMAND.slice(0, 3)).toEqual(["node", "/app/canary-probe.js", "--canary"]);
    expect(fs.readFileSync(path.join(REPO, "src/research-sandbox/preflight.ts"), "utf8")).toContain('["node", "/app/canary-probe.js", PROBE_CANARY_FLAG, canary]');
  });

  it("the three copied files are all the probe needs at run time", () => {
    const imports = (file: string) => ts.createSourceFile(file, fs.readFileSync(path.join(REPO, "src/research-sandbox", file), "utf8"), ts.ScriptTarget.ES2022, true)
      .statements.filter(ts.isImportDeclaration)
      .map((d) => `${d.importClause?.isTypeOnly ? "type " : ""}${(d.moduleSpecifier as ts.StringLiteral).text}`);
    expect(imports("canary-probe.ts")).toEqual(["node:fs", "node:net", "./canary.js"]);
    expect(imports("canary.ts")).toEqual(["type ./spec.js"]); // erased at compile time
    const pkg = JSON.parse(fs.readFileSync(path.join(DIR, "package.json"), "utf8"));
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.scripts).toBeUndefined();
  });
});
