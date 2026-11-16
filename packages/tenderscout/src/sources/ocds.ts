/**
 * Official UK procurement sources, both publishing Open Contracting Data Standard (OCDS) JSON:
 *  - Find a Tender Service (FTS): https://www.find-tender.service.gov.uk/apidocumentation
 *      GET /api/1.0/ocdsReleasePackages?updatedFrom=...&updatedTo=...&limit=100  (paginated via links.next)
 *  - Contracts Finder (CF):       https://www.contractsfinder.service.gov.uk/apidocumentation
 *      GET /Published/Notices/OCDS/Search?stages=tender&publishedFrom=...&limit=100 (paginated via links.next)
 * Both are free, public, no API key, published under the Open Government Licence.
 */
import crypto from "node:crypto";
import type { Tender } from "../types.js";
import { resolveRegion, labelRegions } from "../regions.js";

export const SOURCES = {
  fts: {
    name: "Find a Tender",
    buildUrl: (from: Date, to: Date) =>
      // NB: FTS's stages=tender filter omits most Procurement Act 2023 notices, so fetch all and filter by tag.
      `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?limit=100` +
      `&updatedFrom=${isoNoMs(from)}&updatedTo=${isoNoMs(to)}`,
  },
  cf: {
    name: "Contracts Finder",
    buildUrl: (from: Date, to: Date) =>
      `https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?stages=tender&limit=100` +
      `&publishedFrom=${isoNoMs(from)}&publishedTo=${isoNoMs(to)}`,
  },
} as const;
export type SourceKey = keyof typeof SOURCES;

function isoNoMs(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "");
}

export type Fetcher = (url: string) => Promise<any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET JSON with timeout + retry/backoff (handles 429/5xx/network errors). */
export async function fetchJson(url: string, attempts = 4): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "TenderScoutUK/0.1" },
        signal: AbortSignal.timeout(45_000),
      });
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        lastErr = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        await sleep(ra > 0 ? Math.min(ra, 60) * 1000 : 2000 * 3 ** i);
        continue;
      }
      throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && /HTTP 4\d\d/.test(e.message) && !/429/.test(e.message)) throw e;
      if (i < attempts - 1) await sleep(2000 * 3 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Fetch all releases across pages (follows links.next). */
export async function fetchReleases(source: SourceKey, from: Date, to: Date, fetcher: Fetcher = fetchJson, maxPages = 250): Promise<any[]> {
  let url: string | undefined = SOURCES[source].buildUrl(from, to);
  const out: any[] = [];
  for (let page = 0; url && page < maxPages; page++) {
    const pkg = await fetcher(url);
    if (!pkg || !Array.isArray(pkg.releases)) throw new Error(`Unexpected response shape from ${SOURCES[source].name}`);
    out.push(...pkg.releases);
    const next: string | undefined = pkg.links?.next;
    url = next && next !== url ? next : undefined;
  }
  return out;
}

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Cross-platform dedupe key. Strips leading reference codes ("CA18601 - ", "ID 6841048 - ", "PP-10201 "). */
export function fingerprint(title: string, buyer: string): string {
  const t = title.replace(/^((ID\s*)?[A-Z]{0,4}[-\s]?\d{3,}\s*[-–:]?\s*)+/i, "");
  return hash(`${norm(t)}|${norm(buyer)}`);
}

/** Secondary dedupe key: same buyer + same deadline minute = same notice. */
export function altKey(buyer: string, deadline: string | null): string | null {
  return deadline ? hash(`${norm(buyer)}|${deadline.slice(0, 16)}`) : null;
}

function collectCpv(t: any): string[] {
  const codes = new Set<string>();
  const addC = (c: any) => c?.scheme === "CPV" && c.id && codes.add(String(c.id).slice(0, 8));
  addC(t.classification);
  (t.additionalClassifications ?? []).forEach(addC);
  for (const it of t.items ?? []) {
    addC(it.classification);
    (it.additionalClassifications ?? []).forEach(addC);
  }
  return [...codes];
}

const UK_COUNTRY = /^(gb|uk|united kingdom|great britain|england|scotland|wales|northern ireland)$/i;

function deliveryAddresses(t: any): any[] {
  return [
    ...(t.deliveryAddresses ?? []),
    ...(t.items ?? []).flatMap((i: any) => i.deliveryAddresses ?? []),
    ...(t.lots ?? []).flatMap((l: any) => l.deliveryAddresses ?? []),
  ];
}

/** True when every stated delivery location is outside the UK (e.g. British Council overseas FM). */
export function isOverseasOnly(t: any): boolean {
  const addrs = deliveryAddresses(t).filter((a) => a.country || a.countryName);
  return addrs.length > 0 && addrs.every((a) => !UK_COUNTRY.test(String(a.country ?? a.countryName).trim()));
}

/**
 * Regions from delivery addresses. If delivery is unstated or very broad ("UK", or >3 regions),
 * the buyer's own address is a better guide for local cleaning work, so use that when available.
 */
function collectRegions(r: any): { regions: string[]; label: string } {
  const t = r.tender ?? {};
  const set = new Set<string>();
  for (const a of deliveryAddresses(t)) resolveRegion(a).forEach((x) => set.add(x));
  const delivery = set.has("UK") ? ["UK"] : [...set];
  const broad = delivery.length === 0 || delivery.includes("UK") || delivery.length > 3;
  if (broad) {
    const buyerId = r.buyer?.id;
    const buyer = (r.parties ?? []).find((p: any) => (buyerId && p.id === buyerId) || p.roles?.includes("buyer"));
    const br = buyer?.address ? resolveRegion(buyer.address).filter((x) => x !== "UK") : [];
    if (br.length === 1) return { regions: br, label: `${labelRegions(br)} (buyer location)` };
  }
  return { regions: delivery, label: labelRegions(delivery) };
}

function valueOf(t: any): { amount: number | null; currency: string | null } {
  const v = t.value ?? t.minValue;
  if (v?.amount > 0) return { amount: Number(v.amount), currency: v.currency ?? "GBP" };
  const lots = (t.lots ?? []).map((l: any) => l.value).filter((x: any) => x?.amount > 0);
  if (lots.length) return { amount: lots.reduce((s: number, x: any) => s + Number(x.amount), 0), currency: lots[0].currency ?? "GBP" };
  return { amount: null, currency: null };
}

function noticeUrl(source: SourceKey, r: any): string {
  if (source === "fts") return `https://www.find-tender.service.gov.uk/Notice/${encodeURIComponent(r.id)}`;
  const doc = (r.tender?.documents ?? []).find((d: any) => d.documentType === "tenderNotice" && /^https:\/\/www\.contractsfinder\.service\.gov\.uk\//.test(d.url));
  if (doc) return doc.url;
  const guid = String(r.id).match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  return guid ? `https://www.contractsfinder.service.gov.uk/Notice/${guid}` : "https://www.contractsfinder.service.gov.uk/";
}

function deadlineOf(t: any): { deadline: string | null; deadlineKind: "tender" | "eoi" | null } {
  const iso = (v: any) => (v && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  const lotEnd = (t.lots ?? []).map((l: any) => iso(l.tenderPeriod?.endDate)).filter(Boolean).sort()[0] ?? null;
  const tender = iso(t.tenderPeriod?.endDate) ?? lotEnd;
  if (tender) return { deadline: tender, deadlineKind: "tender" };
  const eoi = iso(t.expressionOfInterestDeadline);
  if (eoi) return { deadline: eoi, deadlineKind: "eoi" };
  return { deadline: null, deadlineKind: null };
}

export function normalizeRelease(source: SourceKey, r: any): Tender | null {
  const t = r?.tender;
  if (!r?.ocid || !t?.title) return null;
  const buyer = clean(r.buyer?.name || (r.parties ?? []).find((p: any) => p.roles?.includes("buyer"))?.name || "Unknown buyer");
  const title = clean(t.title);
  if (isOverseasOnly(t)) return null;
  const { regions, label } = collectRegions(r);
  const { amount, currency } = valueOf(t);
  const tags: string[] = r.tag ?? [];
  let status = clean(t.status || "active").toLowerCase();
  if (tags.includes("tenderCancellation")) status = "cancelled";
  let description = clean(t.description || r.description);
  if (description.length > 420) description = description.slice(0, 417).replace(/\s\S*$/, "") + "…";
  return {
    id: `${source}:${r.ocid}`,
    source,
    ocid: r.ocid,
    fingerprint: fingerprint(title, buyer),
    altKey: null,
    title,
    buyer,
    regions,
    locationLabel: label,
    description,
    valueAmount: amount,
    valueCurrency: currency,
    ...deadlineOf(t),
    published: t.datePublished || r.date || null,
    url: noticeUrl(source, r),
    cpv: collectCpv(t),
    status,
  };
}

function withAltKey(t: Tender): Tender {
  return { ...t, altKey: altKey(t.buyer, t.deadline) };
}

const TENDER_TAGS = ["tender", "tenderUpdate", "tenderAmendment", "tenderCancellation"];
const CLOSED_TAGS = ["award", "awardUpdate", "contract", "contractUpdate", "contractTermination"];

/**
 * Normalise, keeping only the latest release per OCID. Tender-stage releases become open
 * notices; a later award/contract release marks the notice closed ("complete").
 */
export function normalizeAll(source: SourceKey, releases: any[]): Tender[] {
  const latest = new Map<string, any>();
  for (const r of releases) {
    const prev = latest.get(r?.ocid);
    if (!prev || String(r.date) > String(prev.date)) latest.set(r.ocid, r);
  }
  const out: Tender[] = [];
  for (const r of latest.values()) {
    const tags: string[] = r.tag ?? [];
    if (tags.some((t) => TENDER_TAGS.includes(t))) {
      const t = normalizeRelease(source, r);
      if (t) out.push(withAltKey(t));
    } else if (tags.some((t) => CLOSED_TAGS.includes(t))) {
      const t = normalizeRelease(source, r);
      if (t) out.push(withAltKey({ ...t, status: "complete" }));
    }
  }
  return out;
}
