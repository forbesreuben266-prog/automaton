/**
 * Instagram and Pinterest publishing adapters, written from the official documentation (docs/SOCIAL-API-FACTS.md).
 * Each step is classified so that the queue never double-posts:
 *   retryable  nothing was published (a step before publishing failed, or the platform refused with a transient error)
 *   failed     nothing was published and the owner must act (bad token, rejected media, restricted account)
 *   ambiguous  the publishing request may have succeeded (no complete answer to it): needs a human check, never retried
 *
 * Instagram (Instagram API with Instagram Login, graph.instagram.com, v27.0): check the publishing quota, check that the
 * public JPEG matches the queued file, create a container (image_url, caption, alt_text), wait for FINISHED, publish
 * (media_publish), read the permalink. Pinterest (api.pinterest.com/v5, or api-sandbox for Trial/Sandbox tokens):
 * create a Pin on the board with the image sent as base64; the Pin id is stored (the docs give no public Pin URL).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Http } from "./social-http.js";
import type { Platform, PublishAdapter, PublishRequest, PublishResult } from "./social.js";

export const IG_VERSION = "v27.0";
const IG = `https://graph.instagram.com/${IG_VERSION}`;
/** Error subcodes the Instagram docs describe as "try again" or temporary. */
export const IG_RETRYABLE_SUBCODES: ReadonlySet<number> = new Set([2207001, 2207003, 2207008, 2207027, 2207032, 2207042]);
const OAUTH_ERROR = 190;

const json = (b: Buffer): Record<string, any> | null => { try { const v = JSON.parse(b.toString("utf8")); return v && typeof v === "object" ? v : null; } catch { return null; } };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
type IgError = { message?: string; code?: number; error_subcode?: number; is_transient?: boolean };
const igError = (b: Buffer): IgError | null => (json(b)?.error as IgError | undefined) ?? null;
const describe = (status: number, e: IgError | null) => `HTTP ${status}${e ? `: ${(e.message ?? "").slice(0, 160)}${e.code !== undefined ? ` (code ${e.code}${e.error_subcode ? `, subcode ${e.error_subcode}` : ""})` : ""}` : ""}`;
const igRetryable = (status: number, e: IgError | null) => status === 429 || status >= 500 || e?.is_transient === true || (e?.error_subcode !== undefined && IG_RETRYABLE_SUBCODES.has(e.error_subcode));
const refusal = (status: number, b: Buffer): PublishResult => { const e = igError(b); if (e?.code === OAUTH_ERROR) return { kind: "failed", error: `the Instagram token is invalid or expired (${describe(status, e)}): reconnect it` }; return igRetryable(status, e) ? { kind: "retryable", error: describe(status, e) } : { kind: "failed", error: describe(status, e) }; };

export interface InstagramOptions { readonly http: Http; readonly mediaHttp?: Http; readonly sleep?: (ms: number) => Promise<void>; readonly pollAttempts?: number; readonly pollIntervalMs?: number }

export function instagramAdapter(o: InstagramOptions): PublishAdapter {
  const http = o.http, sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const q = (token: string, extra = "") => `access_token=${encodeURIComponent(token)}${extra}`;
  const post = (path: string, token: string, body: Record<string, string>) => http({ method: "POST", url: `${IG}/${path}`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const containerStatus = async (id: string, token: string): Promise<string | null> => {
    try { const r = await http({ method: "GET", url: `${IG}/${id}?fields=status_code&${q(token)}` }); return r.status === 200 ? String(json(r.body)?.status_code ?? "") || null : null; } catch { return null; }
  };
  return {
    platform: "instagram", verified: true, note: "Instagram API with Instagram Login (graph.instagram.com, v27.0), from the official docs",
    async validate(accountId, token) {
      try {
        const r = await http({ method: "GET", url: `${IG}/me?fields=user_id,username&${q(token)}` });
        if (r.status !== 200) return { ok: false, detail: describe(r.status, igError(r.body)) };
        const j = json(r.body), me = (Array.isArray(j?.data) ? j!.data[0] : j) ?? {};
        return String(me.user_id) === accountId ? { ok: true, detail: `token works for @${me.username ?? "?"} (${accountId})` } : { ok: false, detail: `the token belongs to account ${me.user_id ?? "?"}, not ${accountId}` };
      } catch (e) { return { ok: false, detail: `no answer from Instagram: ${(e as Error).message}` }; }
    },
    async publish(req: PublishRequest): Promise<PublishResult> {
      if (req.media.type !== "jpeg") return { kind: "failed", error: "Instagram accepts JPEG images only" };
      if (!req.publicUrl) return { kind: "failed", error: "no public media URL: connect Instagram with --media-base-url and upload the JPEG there" };
      // 1. Publishing quota (nothing sent yet).
      try {
        const r = await http({ method: "GET", url: `${IG}/${req.accountId}/content_publishing_limit?fields=quota_usage,config&${q(req.token)}` });
        if (r.status !== 200) return refusal(r.status, r.body);
        const d = (json(r.body)?.data ?? [])[0] ?? {};
        if (typeof d.quota_usage === "number" && typeof d.config?.quota_total === "number" && d.quota_usage >= d.config.quota_total) return { kind: "retryable", error: `publishing quota reached (${d.quota_usage}/${d.config.quota_total} in 24 hours)` };
      } catch (e) { return { kind: "retryable", error: `quota check: no answer (${(e as Error).message})` }; }
      // 2. The public file must be exactly the queued file (Instagram fetches it from there).
      try {
        const r = await (o.mediaHttp ?? http)({ method: "GET", url: req.publicUrl, timeoutMs: 60_000 });
        if (r.status !== 200) return { kind: "retryable", error: `public media not available yet (HTTP ${r.status} for ${req.publicUrl}): upload ${fs.existsSync(req.media.file) ? req.media.file.split("/").pop() : "the JPEG"} there` };
        if (sha(r.body) !== req.media.sha256) return { kind: "failed", error: `the file at ${req.publicUrl} is not the queued image (SHA-256 differs): upload the queued file` };
      } catch (e) { return { kind: "retryable", error: `public media check: no answer (${(e as Error).message})` }; }
      // 3. Container (creating a container publishes nothing).
      let container: string;
      try {
        const r = await post(`${req.accountId}/media`, req.token, { image_url: req.publicUrl, caption: req.caption, ...(req.altText ? { alt_text: req.altText } : {}) });
        const id = json(r.body)?.id;
        if (r.status !== 200 || typeof id !== "string") return refusal(r.status, r.body);
        container = id;
      } catch (e) { return { kind: "retryable", error: `container creation: no answer (${(e as Error).message}); nothing was published` }; }
      // 4. Wait for FINISHED (docs: once per minute, for no more than 5 minutes).
      const attempts = o.pollAttempts ?? 5;
      let status: string | null = null;
      for (let i = 0; i < attempts; i++) {
        status = await containerStatus(container, req.token);
        if (status && status !== "IN_PROGRESS") break;
        if (i < attempts - 1) await sleep(o.pollIntervalMs ?? 60_000);
      }
      if (status === "ERROR") return { kind: "failed", error: `Instagram could not process the image (container ${container} status ERROR)` };
      if (status === "PUBLISHED") return { kind: "ambiguous", error: `container ${container} already shows PUBLISHED: check the account` };
      if (status !== "FINISHED") return { kind: "retryable", error: `container ${container} not ready (status ${status ?? "unknown"}); nothing was published` };
      // 5. Publish. From here an incomplete answer is ambiguous.
      let mediaId: string;
      try {
        const r = await post(`${req.accountId}/media_publish`, req.token, { creation_id: container });
        const id = json(r.body)?.id;
        if (r.status === 200 && typeof id === "string") mediaId = id;
        else if (r.status >= 400 && r.status < 500 && igError(r.body)) return refusal(r.status, r.body); // a definite refusal: not published
        else {
          const s = await containerStatus(container, req.token);
          return s === "FINISHED" ? { kind: "retryable", error: `publish answered ${describe(r.status, igError(r.body))}; container still FINISHED (not published)` } : { kind: "ambiguous", error: `publish answered ${describe(r.status, igError(r.body))}; container status ${s ?? "unknown"}` };
        }
      } catch (e) {
        const s = await containerStatus(container, req.token);
        return s === "FINISHED" ? { kind: "retryable", error: `publish: no answer (${(e as Error).message}); container still FINISHED (not published)` } : { kind: "ambiguous", error: `publish: no answer (${(e as Error).message}); container status ${s ?? "unknown"}${s === "PUBLISHED" ? ": the post is probably live" : ""}` };
      }
      // 6. Permalink (the post is live whatever happens here).
      try {
        const r = await http({ method: "GET", url: `${IG}/${mediaId}?fields=permalink&${q(req.token)}` });
        const link = json(r.body)?.permalink;
        return { kind: "published", externalId: mediaId, url: r.status === 200 && typeof link === "string" ? link : null };
      } catch { return { kind: "published", externalId: mediaId, url: null }; }
    },
  };
}

export const PINTEREST_HOSTS = { production: "https://api.pinterest.com/v5", sandbox: "https://api-sandbox.pinterest.com/v5" } as const;
export const PIN_LIMITS = { title: 100, description: 800, alt_text: 500, link: 2048 } as const;
const pinError = (status: number, b: Buffer) => { const j = json(b); return `HTTP ${status}${j?.message ? `: ${String(j.message).slice(0, 160)}` : ""}${j?.code !== undefined ? ` (code ${j.code})` : ""}`; };

export function pinterestAdapter(o: { http: Http; environment: "production" | "sandbox" }): PublishAdapter {
  const base = PINTEREST_HOSTS[o.environment];
  return {
    platform: "pinterest", verified: true, note: `Pinterest API v5 (${base.replace("https://", "")}), from the official docs and OpenAPI description`,
    async validate(boardId, token) {
      try {
        const r = await o.http({ method: "GET", url: `${base}/boards/${encodeURIComponent(boardId)}`, headers: { Authorization: `Bearer ${token}` } });
        return r.status === 200 ? { ok: true, detail: `board ${json(r.body)?.name ?? boardId} is reachable with this token` } : { ok: false, detail: pinError(r.status, r.body) };
      } catch (e) { return { ok: false, detail: `no answer from Pinterest: ${(e as Error).message}` }; }
    },
    async publish(req) {
      if (req.title && req.title.length > PIN_LIMITS.title) return { kind: "failed", error: `title longer than ${PIN_LIMITS.title} characters` };
      if (req.caption.length > PIN_LIMITS.description) return { kind: "failed", error: `description longer than ${PIN_LIMITS.description} characters` };
      let data: Buffer; try { data = fs.readFileSync(req.media.file); } catch { return { kind: "failed", error: "media file missing" }; }
      const body = { board_id: req.accountId, title: req.title ?? undefined, description: req.caption, link: req.link, ...(req.altText ? { alt_text: req.altText.slice(0, PIN_LIMITS.alt_text) } : {}),
        media_source: { source_type: "image_base64", content_type: req.media.type === "png" ? "image/png" : "image/jpeg", data: data.toString("base64") } };
      try {
        const r = await o.http({ method: "POST", url: `${base}/pins`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.token}` }, body: JSON.stringify(body), timeoutMs: 60_000 });
        const id = json(r.body)?.id;
        if ((r.status === 200 || r.status === 201) && typeof id === "string") return { kind: "published", externalId: id, url: null };
        if (r.status === 429) return { kind: "retryable", error: pinError(r.status, r.body) };
        if (r.status === 401) return { kind: "failed", error: `the Pinterest token is invalid or expired (${pinError(r.status, r.body)}): refresh or reconnect it` };
        if (r.status >= 400 && r.status < 500) return { kind: "failed", error: pinError(r.status, r.body) };
        return { kind: "ambiguous", error: `${pinError(r.status, r.body)}: the Pin may have been created; check the board` };
      } catch (e) { return { kind: "ambiguous", error: `no complete answer (${(e as Error).message}): the Pin may have been created; check the board` }; }
    },
  };
}

export type AdapterFor = (p: Platform) => PublishAdapter;
