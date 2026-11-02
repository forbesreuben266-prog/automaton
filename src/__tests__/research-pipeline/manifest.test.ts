/** Source manifest parser (Phase 1A step 2). Fictional fixtures only; pure parsing, no files are read. */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  BoundedIssues, MAX_INPUT_NODES, MAX_JSON_DEPTH, MAX_MANIFEST_CHARS, MAX_MANIFEST_SOURCES, MAX_REPORTED_ISSUES, SOURCE_FILE_PATTERN, normalizeInput,
  parseBoundedJson, parseManifest, parseManifestText,
} from "../../research-pipeline/manifest.js";
import { AS_OF, OPPORTUNITY_ID, errorText, validManifest } from "./fixtures.js";

const withSource = (patch: Record<string, unknown>, index = 0) => {
  const m = validManifest();
  m.sources[index] = { ...m.sources[index], ...patch };
  return m;
};

describe("manifest: valid input", () => {
  it("parses the fictional manifest, preserving order and values, and freezes the result", () => {
    const raw = validManifest();
    const m = parseManifest(raw);
    expect(m.version).toBe(1);
    expect(m.opportunityId).toBe(OPPORTUNITY_ID);
    expect(m.runDate).toBe(AS_OF);
    expect(m.sources.map((s) => s.id)).toEqual(raw.sources.map((s: any) => s.id));
    expect(m.sources[0]).toEqual(raw.sources[0]);
    expect(Object.isFrozen(m) && Object.isFrozen(m.sources) && Object.isFrozen(m.sources[0]) && Object.isFrozen(m.sources[0].derivedFromSnapshotIds)).toBe(true);
  });

  it("is deterministic and does not keep references to the caller's objects", () => {
    const raw = validManifest();
    const a = parseManifest(raw);
    raw.sources[0].title = "changed after parsing";
    expect(JSON.stringify(parseManifest(validManifest()))).toBe(JSON.stringify(a));
    expect(a.sources[0].title).not.toBe("changed after parsing");
  });

  it("parses JSON text", () => {
    expect(parseManifestText(JSON.stringify(validManifest())).sources).toHaveLength(validManifest().sources.length);
  });
});

describe("manifest: text limits before parsing", () => {
  it("refuses oversized text before any JSON parsing (the error is about size, not syntax)", () => {
    const huge = "x".repeat(MAX_MANIFEST_CHARS + 1); // not JSON at all
    expect(errorText(() => parseManifestText(huge))).toContain(`the limit is ${MAX_MANIFEST_CHARS}`);
  });

  it.each([
    ["invalid JSON", "{not json", "is not valid JSON"],
    ["a byte-order mark", "\uFEFF{}", "byte-order mark"],
    ["a non-string", 42 as unknown as string, "must be text"],
    ["null", null as unknown as string, "must be text"],
  ])("refuses %s", (_label, text, message) => {
    expect(errorText(() => parseManifestText(text))).toContain(message);
  });

  it("parseBoundedJson accepts exactly the limit and refuses one more character", () => {
    expect(parseBoundedJson('"ab"', "t", 4)).toBe("ab");
    expect(errorText(() => parseBoundedJson('"abc"', "t", 4))).toContain("the limit is 4");
  });
});

describe("manifest: strict structure", () => {
  it.each([
    ["an unknown top-level field", (m: any) => { m.extra = 1; }, "manifest.extra: is not an allowed field"],
    ["a missing field", (m: any) => { delete m.runDate; }, "manifest.runDate: is required"],
    ["an unsupported version", (m: any) => { m.version = 2; }, "manifest.version: must be 1"],
    ["a string version", (m: any) => { m.version = "1"; }, "manifest.version: must be 1"],
    ["a malformed opportunity id", (m: any) => { m.opportunityId = "Dog Walking!"; }, "manifest.opportunityId: has an invalid format"],
    ["an impossible run date", (m: any) => { m.runDate = "2026-02-30"; }, "manifest.runDate"],
    ["no sources", (m: any) => { m.sources = []; }, "manifest.sources: must have at least 1 item"],
    ["sources not an array", (m: any) => { m.sources = {}; }, "manifest.sources: must be an array"],
    ["an unknown source field", (m: any) => { m.sources[0].content = "inline text"; }, "manifest.sources[0].content: is not an allowed field"],
    ["a missing source field", (m: any) => { delete m.sources[0].sha256; }, "manifest.sources[0].sha256: is required"],
    ["a source that is not an object", (m: any) => { m.sources[0] = "council.txt"; }, "manifest.sources[0]: must be a plain object"],
  ])("refuses %s", (_label, mutate, message) => {
    const m = validManifest();
    mutate(m);
    expect(errorText(() => parseManifest(m))).toContain(message);
  });

  it("refuses an oversized source list before reading any entry", () => {
    const m = validManifest();
    m.sources = Array.from({ length: MAX_MANIFEST_SOURCES + 1 }, () => "not even an object");
    const text = errorText(() => parseManifest(m));
    expect(text).toContain(`must have at most ${MAX_MANIFEST_SOURCES} items`);
    expect(text).not.toContain("must be a plain object");
  });

  it("refuses getters without reading them, and a __proto__ key from JSON", () => {
    let reads = 0;
    const m = validManifest();
    Object.defineProperty(m.sources[0], "title", { enumerable: true, get: () => { reads += 1; return "x"; } });
    expect(errorText(() => parseManifest(m))).toContain("must be a plain data value, not a getter/setter");
    expect(reads).toBe(0);
    const text = JSON.stringify(validManifest()).replace('"version":1', '"version":1,"__proto__":{"polluted":true}');
    expect(errorText(() => parseManifestText(text))).toContain("manifest.__proto__: is not an allowed field");
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe("manifest: file names and hashes", () => {
  it.each([
    ["../escape.txt"], ["sub/dir.txt"], ["sub\\dir.txt"], [".hidden.txt"], ["UPPER.txt"], ["report.pdf"], ["no-extension"], ["double.txt.exe"],
    ["space name.txt"], ["C:\\source.txt"], ["%2e%2e.txt"], ["source.txt\u0000"], ["sóurce.txt"], [`${"a".repeat(65)}.txt`], [".txt"], ["-dash.txt"],
  ])("refuses the unsafe or unsupported file name %j", (file) => {
    expect(errorText(() => parseManifest(withSource({ file })))).toContain("manifest.sources[0].file");
  });

  it("accepts plain lower-case .txt and .md names", () => {
    for (const file of ["source-1.txt", "notes_2026.md", "a.txt"]) expect(SOURCE_FILE_PATTERN.test(file)).toBe(true);
    expect(parseManifest(withSource({ file: "notes_2026.md" })).sources[0].file).toBe("notes_2026.md");
  });

  it.each([["ABCDEF".repeat(10) + "abcd"], ["abc"], ["g".repeat(64)], [123]])("refuses the malformed SHA-256 %j", (sha256) => {
    expect(errorText(() => parseManifest(withSource({ sha256 })))).toContain("manifest.sources[0].sha256");
  });
});

describe("manifest: snapshot metadata uses Phase 0's rules", () => {
  it.each([
    ["a non-http URL", { url: "javascript:alert(1)" }, "manifest.sources[0].url"],
    ["a number instead of a publisher (never converted)", { publisher: 42 }, "manifest.sources[0].publisher: must be a string (got number)"],
    ["a publication date after retrieval", { publishedAt: "2026-12-31", retrievedAt: "2026-10-01T00:00:00Z" }, "manifest.sources[0].publishedAt: is after retrievedAt"],
    ["verified independence without a note", { independenceVerified: true, independenceNote: "" }, "manifest.sources[0].independenceNote"],
    ["a source derived from itself", { derivedFromSnapshotIds: ["__self__"] }, "must not include the snapshot itself"],
    ["a malformed origin id", { originId: "Not An Id" }, "manifest.sources[0].originId: has an invalid format"],
    ["a non-UTC retrieval time", { retrievedAt: "2026-10-01T00:00:00+01:00" }, "manifest.sources[0].retrievedAt"],
  ])("refuses %s", (_label, patch, message) => {
    const m = validManifest();
    const p: any = { ...patch };
    if (p.derivedFromSnapshotIds?.[0] === "__self__") p.derivedFromSnapshotIds = [m.sources[0].id];
    m.sources[0] = { ...m.sources[0], ...p };
    expect(errorText(() => parseManifest(m))).toContain(message);
  });

  it("refuses a source retrieved after the run date", () => {
    expect(errorText(() => parseManifest(withSource({ retrievedAt: "2026-10-16T00:00:00Z" })))).toContain("is after the run date 2026-10-15");
  });

  it("accepts a source without a publication date (Phase 0 treats it as stale)", () => {
    expect(parseManifest(withSource({ publishedAt: null })).sources[0].publishedAt).toBeNull();
  });
});

describe("manifest: duplicates and references", () => {
  it("refuses duplicate source ids", () => {
    const m = validManifest();
    m.sources[1] = { ...m.sources[1], id: m.sources[0].id };
    expect(errorText(() => parseManifest(m))).toContain(`duplicate id "${m.sources[0].id}"`);
  });

  it("refuses duplicate file names", () => {
    const m = validManifest();
    m.sources[1] = { ...m.sources[1], file: m.sources[0].file };
    expect(errorText(() => parseManifest(m))).toContain(`duplicate id "${m.sources[0].file}"`);
  });

  it("refuses a derived-from reference to a source that isn't in the manifest", () => {
    expect(errorText(() => parseManifest(withSource({ derivedFromSnapshotIds: ["ghost-source"] })))).toContain('unknown source "ghost-source"');
  });

  it("reports every problem at once", () => {
    const m = validManifest();
    m.sources[0].file = "../x.txt";
    m.sources[1].sha256 = "short";
    const text = errorText(() => parseManifest(m));
    expect(text).toContain("manifest.sources[0].file");
    expect(text).toContain("manifest.sources[1].sha256");
  });
});

/* ------------------------------------------------------------------ */
/* Step 2 review fixes: F1 (read once), F2 (sparse arrays), F3 (duplicate JSON keys), F4 (unsafe text). */
/* ------------------------------------------------------------------ */

const U = (code: number) => String.fromCharCode(code); // builds test characters without putting raw controls in the source

describe("F3 (JSON-reachable): bounded, syntax-aware parsing rejects duplicate keys and malformed JSON", () => {
  const json = JSON.stringify(validManifest());

  it.each([
    ["at the top level (first value valid)", json.replace('"version":1', '"version":1,"version":2')],
    ["at the top level (last value valid; JSON.parse alone would keep it)", json.replace('"version":1', '"version":2,"version":1')],
    ["inside a nested source object", json.replace('"file":', '"sha256":"x","file":')],
    ["spelled with a unicode escape (\\u0076ersion = version)", json.replace('"version":1', '"version":1,"\\u0076ersion":1')],
    ["inside an empty-looking nested object", '{"a":{"b":1,"b":1}}'],
  ])("refuses a duplicate key %s", (_label, text) => {
    expect(errorText(() => parseManifestText(text))).toContain("duplicate object key");
  });

  it("allows the same key in sibling objects (each object is checked separately)", () => {
    expect(() => parseManifestText(json)).not.toThrow(); // every source object repeats the same field names
  });

  it.each([
    ["a trailing comma in an object", '{"a":1,}'], ["a trailing comma in an array", "[1,]"], ["single quotes", "{'a':1}"],
    ["a comment", '{"a":1 /* c */}'], ["NaN", '{"a":NaN}'], ["Infinity", '{"a":Infinity}'], ["a leading zero", '{"a":01}'],
    ["an unterminated string", '{"a":"x'], ["an invalid escape", '{"a":"\\x"}'], ["a short unicode escape", '{"a":"\\u12"}'],
    ["a raw control character inside a string", `{"a":"x${U(1)}y"}`], ["trailing characters", '{"a":1} {}'], ["empty text", ""],
    ["an unquoted key", "{a:1}"], ["a missing colon", '{"a" 1}'], ["a lone value separator", "[,1]"], ["a plus sign", '{"a":+1}'],
  ])("refuses %s", (_label, text) => {
    expect(errorText(() => parseBoundedJson(text, "t", 1000))).toContain("t: is not valid JSON");
  });

  it("refuses nesting deeper than the limit, iteratively (no stack overflow on very deep input)", () => {
    expect(errorText(() => parseBoundedJson("[".repeat(MAX_JSON_DEPTH + 1) + "]".repeat(MAX_JSON_DEPTH + 1), "t", 1000))).toContain(`nesting deeper than ${MAX_JSON_DEPTH} levels`);
    expect(errorText(() => parseBoundedJson("[".repeat(400_000), "t", 1_000_000))).toContain("nesting deeper");
    expect(parseBoundedJson("[".repeat(MAX_JSON_DEPTH) + "]".repeat(MAX_JSON_DEPTH), "t", 1000)).toBeDefined();
  });

  it("accepts valid JSON forms and decodes them exactly like JSON.parse", () => {
    const text = '{"s":"a\\"b\\\\c\\/d\\n\\u00e9\\ud83d\\ude00","n":[0,-1,1.5,2e3,-0.25E-2],"t":true,"f":false,"z":null,"e":{},"a":[]}';
    expect(parseBoundedJson(text, "t", 1000)).toEqual(JSON.parse(text));
  });

  it("still refuses oversized text before scanning (size is checked first)", () => {
    expect(errorText(() => parseBoundedJson('{"a":1,"a":2}', "t", 5))).toContain("the limit is 5");
  });
});

describe("F1 (direct API): each value is read once; the value validated is the value stored", () => {
  const proxySource = (sequence: string[]) => {
    let reads = 0;
    const target = { ...validManifest().sources[0] };
    return new Proxy(target, {
      get: (t: any, k) => (k === "file" ? sequence[Math.min(reads++, sequence.length - 1)] : t[k]),
      getOwnPropertyDescriptor: (t, k) => {
        const d = Object.getOwnPropertyDescriptor(t, k);
        return k === "file" && d ? { ...d, value: sequence[Math.min(reads++, sequence.length - 1)] } : d;
      },
    });
  };

  it("an unsafe name on the first read is refused even if later reads return a safe one", () => {
    const m = validManifest();
    m.sources[0] = proxySource(["../escape.txt", "safe.txt", "safe.txt"]);
    expect(errorText(() => parseManifest(m))).toContain("manifest.sources[0].file");
  });

  it("a safe first read followed by unsafe later reads stores only the safe, validated name", () => {
    const m = validManifest();
    m.sources[0] = proxySource(["safe.txt", "../escape.txt", "../escape.txt"]);
    const parsed = parseManifest(m);
    expect(parsed.sources[0].file).toBe("safe.txt");
    expect(SOURCE_FILE_PATTERN.test(parsed.sources[0].file)).toBe(true);
  });

  it("a getter is refused without being called", () => {
    let calls = 0;
    const m = validManifest();
    Object.defineProperty(m.sources[0], "file", { enumerable: true, get: () => { calls += 1; return "safe.txt"; } });
    expect(errorText(() => parseManifest(m))).toContain("manifest.sources[0].file: must be a plain data value, not a getter/setter");
    expect(calls).toBe(0);
  });

  it("the parsed result keeps no link to the caller's objects", () => {
    const m = validManifest();
    const parsed = parseManifest(m);
    m.sources[0].file = "../changed.txt";
    expect(parsed.sources[0].file).toBe(validManifest().sources[0].file);
  });
});

describe("F2 (direct API): sparse arrays and arrays with extra properties are refused at any depth", () => {
  const sparse = (length: number, set: Record<number, unknown>) => {
    const a: unknown[] = [];
    a.length = length;
    for (const [i, v] of Object.entries(set)) a[Number(i)] = v;
    return a;
  };

  it("a hole in the source list is refused, not skipped", () => {
    const m = validManifest();
    m.sources = sparse(m.sources.length, Object.fromEntries(m.sources.slice(1).map((s: any, i: number) => [i + 1, s])));
    expect(errorText(() => parseManifest(m))).toContain("manifest.sources[0]: is missing (sparse arrays are not allowed)");
  });

  it("a hole in a nested array (derivedFromSnapshotIds) is refused", () => {
    const m = validManifest();
    m.sources[1].derivedFromSnapshotIds = sparse(2, { 1: m.sources[0].id });
    expect(errorText(() => parseManifest(m))).toContain("manifest.sources[1].derivedFromSnapshotIds[0]: is missing");
  });

  it("an array with an extra named property is refused", () => {
    const m = validManifest();
    (m.sources as any).note = "smuggled";
    expect(errorText(() => parseManifest(m))).toContain("manifest.sources: must not have properties other than its elements");
  });
});

describe("F4: unsafe text is refused; ordinary Unicode is kept", () => {
  const titled = (title: string) => withSource({ title });
  const noted = (independenceNote: string) => withSource({ independenceNote });

  it.each([
    ["NUL", U(0)], ["ESC (start of an ANSI escape sequence)", `${U(0x1b)}[31mred${U(0x1b)}[0m`], ["CSI (8-bit ANSI)", `${U(0x9b)}31m`], ["DEL", U(0x7f)],
    ["BEL", U(7)], ["a form feed", U(0x0c)], ["a right-to-left override", `abc${U(0x202e)}cba`], ["a left-to-right embedding", U(0x202a)],
    ["a first-strong isolate", U(0x2068)], ["a right-to-left mark", U(0x200f)], ["an Arabic letter mark", U(0x061c)],
    ["an unpaired high surrogate", `a${U(0xd800)}b`], ["an unpaired low surrogate", `a${U(0xdc00)}b`], ["a reversed surrogate pair", `${U(0xdc00)}${U(0xd800)}`],
    ["a lone carriage return", "line1\rline2"],
  ])("refuses %s in free text", (_label, text) => {
    expect(errorText(() => parseManifest(noted(`note ${text} end`)))).toContain("manifest.sources[0].independenceNote: contains");
  });

  it("the same characters are refused when they arrive through JSON escapes", () => {
    const text = JSON.stringify(validManifest()).replace('"independenceNote":"', '"independenceNote":"\\u001b[2J \\u202e \\ud800 ');
    const errors = errorText(() => parseManifestText(text));
    expect(errors).toContain("disallowed control, escape or bidi character (U+001B)");
    expect(errors).toContain("unpaired surrogate");
  });

  it.each([
    ["a line break", "title\nsecond line"], ["a tab", "title\tcolumn"], ["a CRLF line break", "title\r\nsecond"],
  ])("refuses %s in a single-line field (title)", (_label, text) => {
    expect(errorText(() => parseManifest(titled(text)))).toContain("manifest.sources[0].title: must be a single line");
  });

  it.each([
    ["accented Latin", "Café Société — Ærøskøbing"], ["CJK", "東京の犬の散歩サービス"], ["Arabic letters (no bidi controls)", "خدمة تمشية الكلاب"],
    ["an emoji (a valid surrogate pair)", "Dog walking 🐕"], ["a ZWJ emoji sequence", "👩‍💻 walker"], ["mathematical symbols", "≤ 80 walks · £15"],
  ])("keeps %s", (_label, text) => {
    expect(parseManifest(titled(text)).sources[0].title).toBe(text);
  });

  it("keeps line breaks, CRLF and tabs where the field permits them (multi-line text)", () => {
    expect(parseManifest(noted("line one\nline two\r\nline three\tcol")).sources[0].independenceNote).toBe("line one\nline two\r\nline three\tcol");
  });

  it("never echoes the refused text in the error message", () => {
    const secret = `SECRET-VALUE${U(0x1b)}`;
    expect(errorText(() => parseManifest(noted(secret)))).not.toContain("SECRET-VALUE");
  });
});

describe("prototype keys and inherited properties", () => {
  it.each([["__proto__"], ["constructor"], ["prototype"]])("JSON-reachable: a %s key is refused as an unknown field and pollutes nothing", (key) => {
    const text = JSON.stringify(validManifest()).replace('"version":1', `"version":1,"${key}":{"polluted":true}`);
    expect(errorText(() => parseManifestText(text))).toContain(`manifest.${key}: is not an allowed field`);
    expect(({} as any).polluted).toBeUndefined();
  });

  it("direct API: an inherited property from an already-polluted Object.prototype can't supply a missing field", () => {
    const m = validManifest();
    delete m.sources[0].sha256;
    (Object.prototype as any).sha256 = "a".repeat(64);
    try {
      expect(errorText(() => parseManifest(m))).toContain("manifest.sources[0].sha256: is required");
    } finally {
      delete (Object.prototype as any).sha256;
    }
  });

  it("direct API: a polluted Array.prototype index can't fill a hole", () => {
    const m = validManifest();
    const holey: unknown[] = [];
    holey.length = 1;
    m.sources[1].derivedFromSnapshotIds = holey;
    (Array.prototype as any)[0] = m.sources[0].id;
    try {
      expect(errorText(() => parseManifest(m))).toContain("derivedFromSnapshotIds[0]: is missing");
    } finally {
      delete (Array.prototype as any)[0];
    }
  });
});

describe("unusual values and objects (direct API only; JSON can't express them)", () => {
  it.each([
    ["a class instance", () => new (class { version = 1; })(), "manifest: must be a plain object"],
    ["a Map", () => new Map(), "manifest: must be a plain object"],
    ["a Date", () => new Date(0), "manifest: must be a plain object"],
    ["an array subclass", () => new (class extends Array {})(), "manifest: must be a plain array"],
    ["a function", () => () => 1, "manifest: has an unsupported type (function)"],
    ["a BigInt", () => BigInt(1), "manifest: has an unsupported type (bigint)"],
    ["a symbol", () => Symbol("x"), "manifest: has an unsupported type (symbol)"],
    ["undefined", () => undefined, "manifest: has an unsupported type (undefined)"],
    ["a revoked Proxy", () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; }, "manifest: could not be read as plain data"],
  ])("refuses %s", (_label, make, message) => {
    expect(errorText(() => parseManifest(make()))).toContain(message);
  });

  it.each([
    ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY],
  ])("refuses %s anywhere in the input", (_label, value) => {
    const m = validManifest();
    m.extra = value;
    expect(errorText(() => parseManifest(m))).toContain("manifest.extra: must be a finite number");
  });

  it("refuses symbol keys and non-enumerable properties", () => {
    const a = validManifest();
    a[Symbol("hidden")] = 1;
    expect(errorText(() => parseManifest(a))).toContain("manifest: must not have symbol keys");
    const b = validManifest();
    Object.defineProperty(b, "runDate", { value: b.runDate, enumerable: false });
    expect(errorText(() => parseManifest(b))).toContain("manifest.runDate: must be an ordinary (enumerable) property");
  });

  it("refuses inputs with too many values or nested too deeply", () => {
    expect(errorText(() => parseManifest({ big: new Array(MAX_INPUT_NODES + 1).fill(0) }))).toContain(`has more than ${MAX_INPUT_NODES} values`);
    let deep: any = {};
    for (let d = 0; d < MAX_JSON_DEPTH + 2; d++) deep = { d: deep };
    expect(errorText(() => parseManifest(deep))).toContain(`is nested deeper than ${MAX_JSON_DEPTH} levels`);
  });

  it("accepts a null-prototype object (plain data)", () => {
    expect(parseManifest(Object.assign(Object.create(null), validManifest())).sources.length).toBe(validManifest().sources.length);
  });
});

/* ------------------------------------------------------------------ */
/* Final-review fixes: D1 (bounded work), D2 (bounded issues), D3 (documented limitation). */
/* ------------------------------------------------------------------ */

describe("D1 (direct API): work is bounded before it is done", () => {
  /** Wraps a target so we can count how many property descriptors are read and how often keys are listed. */
  const counting = (target: object) => {
    const counts = { descriptors: 0, ownKeys: 0 };
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor: (t, k) => { counts.descriptors += 1; return Object.getOwnPropertyDescriptor(t, k); },
      ownKeys: (t) => { counts.ownKeys += 1; return Object.getOwnPropertyNames(t); },
    });
    return { proxy, counts };
  };
  const sparse = (length: number) => { const a: unknown[] = []; a.length = length; return a; };

  it.each([
    ["the maximum array length (2^32 - 1)", 2 ** 32 - 1], ["one more than the budget", MAX_INPUT_NODES + 1], ["ten million", 10_000_000],
  ])("an empty array declaring %s is refused immediately, without visiting entries or listing keys", (_label, length) => {
    const { proxy, counts } = counting(sparse(length));
    const started = Date.now();
    expect(errorText(() => normalizeInput({ a: proxy }, "x"))).toContain(`x: has more than ${MAX_INPUT_NODES} values`);
    expect(counts.descriptors).toBe(1); // only "length"
    expect(counts.ownKeys).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a dense array over the budget is refused before its keys are listed or any element is read", () => {
    const { proxy, counts } = counting(new Array(MAX_INPUT_NODES + 1).fill(0));
    expect(errorText(() => normalizeInput({ a: proxy }, "x"))).toContain(`has more than ${MAX_INPUT_NODES} values`);
    expect(counts.descriptors).toBe(1);
    expect(counts.ownKeys).toBe(0);
  });

  it("an object with more own keys than the budget is refused before any property is read", () => {
    const names = Array.from({ length: MAX_INPUT_NODES + 1 }, (_, i) => `k${i}`);
    let descriptorReads = 0;
    const proxy = new Proxy({}, {
      ownKeys: () => names,
      getOwnPropertyDescriptor: () => { descriptorReads += 1; return { value: 1, enumerable: true, configurable: true, writable: true }; },
    });
    expect(errorText(() => normalizeInput(proxy, "x"))).toContain(`has more than ${MAX_INPUT_NODES} values`);
    expect(descriptorReads).toBe(0);
  });

  it("the budget is cumulative: a later array that no longer fits is refused before its entries are read", () => {
    const { proxy, counts } = counting(new Array(150_000).fill(0));
    expect(errorText(() => normalizeInput({ first: new Array(200_000).fill(0), second: proxy }, "x"))).toContain("has more than");
    expect(counts.descriptors).toBe(1);
  });

  it("holes count against the budget (a large sparse array can't hide work)", () => {
    expect(errorText(() => normalizeInput({ holes: sparse(250_000), values: new Array(60_000).fill(0) }, "x"))).toContain(`has more than ${MAX_INPUT_NODES} values`);
  });

  it("within the budget, each property's descriptor is still read exactly once and getters are never called", () => {
    let getterCalls = 0;
    const plain = { a: 1, b: [1, 2, 3], c: { d: "x" } };
    const { proxy, counts } = counting(plain);
    const withGetter = { g: 1 };
    Object.defineProperty(withGetter, "g", { enumerable: true, get: () => { getterCalls += 1; return 1; } });
    expect(normalizeInput(proxy, "x")).toEqual(Object.assign(Object.create(null), { a: 1, b: [1, 2, 3], c: Object.assign(Object.create(null), { d: "x" }) }));
    expect(counts.descriptors).toBe(3); // a, b, c: one read each
    expect(errorText(() => normalizeInput(withGetter, "x"))).toContain("not a getter/setter");
    expect(getterCalls).toBe(0);
  });

  it("an array that misreports its length is refused", () => {
    const liar = new Proxy([], { getOwnPropertyDescriptor: (t, k) => (k === "length" ? { value: -1, writable: true, enumerable: false, configurable: false } : Object.getOwnPropertyDescriptor(t, k)) });
    expect(errorText(() => normalizeInput({ a: liar }, "x"))).toMatch(/x\.a: (must be a plain array|could not be read as plain data)/);
  });
});

describe("D2: validation issues are bounded for JSON and direct inputs", () => {
  const issuesOf = (fn: () => unknown): string[] => {
    try { fn(); } catch (err) { return (err as { issues: string[] }).issues; }
    throw new Error("expected a refusal");
  };

  it("a large invalid manifest (JSON) keeps at most MAX_REPORTED_ISSUES detailed issues plus one summary line", () => {
    const m = validManifest();
    m.sources = Array.from({ length: 150 }, (_, i) => ({ ...m.sources[0], id: `s${i}`, file: `../bad-${i}.txt`, sha256: "short" }));
    const issues = issuesOf(() => parseManifestText(JSON.stringify(m)));
    expect(issues.length).toBe(MAX_REPORTED_ISSUES + 1);
    expect(issues[issues.length - 1]).toMatch(/^\(\d+ further issue\(s\) omitted; fix the ones listed and check again\)$/);
  });

  it("direct input with many invalid values is bounded the same way", () => {
    const issues = issuesOf(() => normalizeInput({ values: new Array(5_000).fill(Number.NaN) }, "x"));
    expect(issues.length).toBe(MAX_REPORTED_ISSUES + 1);
    expect(issues[issues.length - 1]).toContain("4900 further issue(s) omitted");
  });

  it("exactly MAX_REPORTED_ISSUES issues are reported in full, with no summary line", () => {
    const issues = issuesOf(() => normalizeInput({ values: new Array(MAX_REPORTED_ISSUES).fill(Number.NaN) }, "x"));
    expect(issues.length).toBe(MAX_REPORTED_ISSUES);
    expect(issues.some((m) => m.includes("omitted"))).toBe(false);
  });

  it("the bounded collector still refuses: an omitted-only overflow is never mistaken for success", () => {
    const b = new BoundedIssues();
    for (let i = 0; i < MAX_REPORTED_ISSUES + 5; i++) b.add(`p${i}`, "bad");
    expect(b.list.length).toBe(MAX_REPORTED_ISSUES);
    expect(b.omitted).toBe(5);
    expect(() => b.throwIfAny()).toThrow("5 further issue(s) omitted");
    expect(() => new BoundedIssues().throwIfAny()).not.toThrow();
  });
});

describe("D3: the documented limitation of direct object input", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../research-pipeline/manifest.ts"), "utf8");

  it("states that Proxy traps run caller code, that this is not a sandbox, and that JSON text is the intended path", () => {
    expect(source).toContain("NOT A SANDBOX");
    expect(source).toContain("Proxy traps (getPrototypeOf, ownKeys, getOwnPropertyDescriptor) are");
    expect(source).toContain("it is not a sandbox");
    expect(source).toContain("or a safe execution boundary for arbitrary JavaScript objects");
    expect(source).toContain("The intended input path is JSON text");
  });

  it("demonstrates the limitation: a Proxy trap runs during normalisation (direct API only)", () => {
    let trapRan = false;
    const hostile = new Proxy({}, { ownKeys: () => { trapRan = true; return []; } });
    normalizeInput(hostile, "x");
    expect(trapRan).toBe(true);
    // JSON input can't do this: JSON.parse only produces plain data.
    const parsed = JSON.parse('{"ownKeys":"not a trap"}');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});
