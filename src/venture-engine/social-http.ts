/**
 * The only network client for social publishing. It reaches exactly the official API hosts (plus, for Instagram media
 * checks, the one HTTPS media host the owner configured), never follows redirects, refuses URLs with credentials,
 * times out, and caps response size. Tokens are sent only in requests to the API hosts and are never logged here.
 */

export const API_HOSTS: ReadonlySet<string> = new Set(["graph.instagram.com", "api.pinterest.com", "api-sandbox.pinterest.com"]);
export const MAX_RESPONSE_BYTES = 9 * 1024 * 1024;

export interface HttpRequest { readonly method: "GET" | "POST"; readonly url: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string; readonly timeoutMs?: number }
export interface HttpResponse { readonly status: number; readonly body: Buffer }
/** Resolves with the HTTP status and body; rejects only when no complete response was received (network or timeout). */
export type Http = (r: HttpRequest) => Promise<HttpResponse>;

export function checkUrl(raw: string, extraHosts: readonly string[] = []): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("not a URL"); }
  if (u.protocol !== "https:" || u.username || u.password || u.port) throw new Error(`only plain https URLs are allowed (${u.host})`);
  if (!API_HOSTS.has(u.hostname) && !extraHosts.includes(u.hostname)) throw new Error(`host not allowed: ${u.hostname}`);
  return u;
}

/** A client pinned to the allowed hosts. `extraHosts` is only the owner's media host, for reading public media. */
export function pinnedHttp(extraHosts: readonly string[] = []): Http {
  return async (r) => {
    const u = checkUrl(r.url, extraHosts);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), r.timeoutMs ?? 30_000);
    try {
      const res = await fetch(u.toString(), { method: r.method, headers: r.headers, body: r.body, redirect: "manual", signal: ctl.signal });
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > MAX_RESPONSE_BYTES) throw new Error("response too large");
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_RESPONSE_BYTES) throw new Error("response too large");
      return { status: res.status, body };
    } finally { clearTimeout(timer); }
  };
}
