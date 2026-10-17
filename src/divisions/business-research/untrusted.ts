/**
 * Output escaping for untrusted text.
 *
 * Source content, quotes, titles, publishers and (later) model-written
 * statements are all data. They are never evaluated, parsed as commands or
 * passed to a tool. When rendered into a Markdown report they are flattened
 * to one line and escaped, so they can't inject headings, links, images,
 * HTML or fake report sections (e.g. a forged "Verdict: pursue" line).
 */

const MARKDOWN_SPECIAL = /[\\`*_{}[\]()#|<>~!]/g;
// C0/C1 controls, bidi overrides/isolates and zero-width characters.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

export function escapeInline(text: string, maxChars = 2_000): string {
  if (typeof text !== "string") return "\\[non-text value\\]"; // never coerced
  let flat = text.normalize("NFC").replace(/\s+/g, " ").replace(INVISIBLE, "").trim();
  if (flat.length > maxChars) flat = `${flat.slice(0, maxChars)}…`;
  return flat.replace(MARKDOWN_SPECIAL, (c) => `\\${c}`);
}

/** http(s) URL as an autolink; anything else is shown as escaped text. */
export function renderUrl(url: string): string {
  if (typeof url !== "string") return "\\[non-text value\\]";
  try {
    const parsed = new URL(url); // parsing only; never requested
    if ((parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password) {
      return `<${parsed.href.replace(/[<>\s]/g, encodeURIComponent)}>`;
    }
  } catch {
    // fall through
  }
  return escapeInline(url);
}
