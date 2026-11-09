/**
 * Shared pieces for product blueprints. A blueprint turns one venture's opportunity (and its existing outline) into a
 * complete, usable digital product: real files a buyer can open and edit (Markdown, CSV, printable HTML), plus the
 * pitch used for the landing page. Blueprints are deterministic: no model, no network, no randomness.
 *
 * Conventions checked by the product QA:
 *  - Fill-in fields are written [[Like this]] and are allowed only in files marked template: true.
 *  - Files that touch legal, tax or financial topics carry DISCLAIMER.
 *  - CSV cells never start with = + - @ (formula injection), except plain negative numbers.
 */

import type { Opportunity } from "../types.js";

export type Currency = "USD" | "GBP" | "EUR";
export const CURRENCIES: readonly Currency[] = ["USD", "GBP", "EUR"];
export const SYMBOL: Readonly<Record<Currency, string>> = { USD: "$", GBP: "£", EUR: "€" };

export interface ProductFile {
  /** Plain file name (the store's writer refuses anything else). */
  readonly name: string;
  /** One line for start-here.md and the landing page. */
  readonly description: string;
  /** True when the file is meant to be filled in by the buyer ([[fields]] allowed). */
  readonly template: boolean;
  readonly text: string;
}
export interface Pitch { readonly headline: string; readonly subheadline: string; readonly benefits: readonly string[]; readonly faq: readonly { readonly q: string; readonly a: string }[] }
export interface Section { readonly heading: string; readonly bullets: readonly string[] }
export interface BlueprintInput {
  readonly opportunity: Opportunity;
  /** Sections of the venture's latest product outline (placeholders already removed); may be empty. */
  readonly outline: readonly Section[];
  readonly price: number;
  readonly currency: Currency;
}
export interface Blueprint {
  readonly id: string;
  readonly defaultPrice: number;
  matches(o: Opportunity): boolean;
  productName(i: BlueprintInput): string;
  pitch(i: BlueprintInput): Pitch;
  files(i: BlueprintInput): ProductFile[];
}

export const DISCLAIMER = "This material is general information to help you organise your work. It is not legal, tax or financial advice. Rules differ between countries and change over time: check the rules that apply to you, and ask a qualified adviser if you are unsure.";

/** One CSV cell: quoted when needed; never lets a spreadsheet treat it as a formula. */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d+(\.\d+)?$/.test(s))) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csv = (rows: readonly (readonly (string | number)[])[]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const money = (i: BlueprintInput) => `${SYMBOL[i.currency]}${i.price.toFixed(2).replace(/\.00$/, "")}`;
export const words = (o: Opportunity) => `${o.title} ${o.problem} ${o.offer}`.toLowerCase();
