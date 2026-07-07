// Open-Meteo API client.
//
// Replaces the NS API client. Open-Meteo is plain JSON over HTTP GET — no
// scraping, no rotating key. The free tier needs no authentication. The
// commercial tier requires BOTH a `customer-` host prefix AND an `&apikey=`
// query parameter (supplied here via the `apikey` ATTACH option). Responses
// are cached per fully-resolved URL with a per-call TTL.

const REQUEST_TIMEOUT_MS = 15_000;

/** Default cache TTL when a call doesn't specify one. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class OpenMeteoError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenMeteoError";
  }
}

interface CacheEntry {
  data: any;
  fetchedAt: number;
}

const _cache = new Map<string, CacheEntry>();

async function httpGet(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map a free-tier host to its commercial counterpart by prepending the
 * `customer-` prefix the reserved API servers live behind, e.g.
 * `api.open-meteo.com` → `customer-api.open-meteo.com`,
 * `archive-api.open-meteo.com` → `customer-archive-api.open-meteo.com`.
 */
function customerHost(host: string): string {
  return host.startsWith("customer-") ? host : `customer-${host}`;
}

export type OmQuery = Record<string, string | number | boolean | null | undefined>;

export interface OmGetOptions {
  /** Commercial API key. When present, switches host + appends `apikey`. */
  apikey?: string;
  /** Cache TTL in milliseconds for this call. */
  ttlMs?: number;
}

/**
 * GET an Open-Meteo endpoint and return the parsed JSON. `host` is the
 * free-tier hostname (e.g. `api.open-meteo.com`); when `opts.apikey` is set it
 * is rewritten to the `customer-` host and the key is appended. Empty/undefined
 * query values are dropped.
 */
export async function omGet(
  host: string,
  path: string,
  query: OmQuery,
  opts?: OmGetOptions,
): Promise<any> {
  const apikey = opts?.apikey && opts.apikey.length > 0 ? opts.apikey : undefined;
  const effectiveHost = apikey ? customerHost(host) : host;

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  if (apikey) params.set("apikey", apikey);

  const url = `https://${effectiveHost}${path}?${params.toString()}`;

  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const cached = _cache.get(url);
  if (cached && now - cached.fetchedAt < ttl) return cached.data;

  const resp = await httpGet(url);
  if (!resp.ok) {
    // Open-Meteo error bodies are `{"error": true, "reason": "..."}`.
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body && typeof body.reason === "string") detail = `${detail}: ${body.reason}`;
    } catch {
      // non-JSON error body — keep the status-only message
    }
    throw new OpenMeteoError(url, resp.status, `Open-Meteo ${path}: ${detail}`);
  }

  const data = await resp.json();
  _cache.set(url, { data, fetchedAt: now });
  return data;
}

/** Test-only helper: clear the response cache between tests. */
export function _resetCaches(): void {
  _cache.clear();
}
