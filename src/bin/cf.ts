// Cloudflare Workers entry point for the Open-Meteo VGI worker.
//
// Exposes the same catalog + function registry as the stdio (worker.ts) and Bun
// HTTP (serve.ts) entries, in the `export default { fetch }` shape the Workers
// runtime expects. `createVgiFetch` comes from `vgi/worker-cf`, whose workerd
// export condition resolves the flechette Arrow backend at build time — so no
// arrow-js is bundled for the edge.
//
// The Worker is stateless across requests: per-request exchange state round-trips
// through an AEAD-sealed token keyed off VGI_SIGNING_KEY (set as a Wrangler
// secret). A stable key is required — Workers don't preserve in-memory state
// across isolates, so without it a multi-request query (bind → scan) would fail
// when it lands on a different isolate.

import {
  CompositeCatalogInterface,
  createVgiFetch,
  FunctionRegistry,
} from "vgi/worker-cf";

import { buildRegistry, openMeteoCatalog, OpenMeteoCatalog } from "../catalog.js";

// Shown on the landing page. Kept in step with package.json by hand: the
// tsconfig has neither resolveJsonModule nor package.json in `include`, so an
// import here would need config changes for one string.
const WORKER_VERSION = "0.2.1";

export interface Env {
  /** Stable secret, SHA-256'd to the 32-byte state-token key. Set via
   *  `wrangler secret put VGI_SIGNING_KEY`. */
  VGI_SIGNING_KEY?: string;
  /** State-token TTL in seconds (default 3600). */
  VGI_TOKEN_TTL?: string;
  /** CORS allowed origins. Defaults to `*` when unset — see the note on
   *  `corsOrigins` below for why this defaults on rather than off. */
  VGI_HTTP_CORS_ORIGINS?: string;
}

async function sha256Key(secret: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return new Uint8Array(digest);
}

// One handler per isolate, cached and rebuilt only if the signing key changes.
let cached: { key: string; handler: (req: Request) => Promise<Response> } | null = null;

async function getHandler(env: Env): Promise<(req: Request) => Promise<Response>> {
  const keyMaterial = env.VGI_SIGNING_KEY ?? "";
  if (cached && cached.key === keyMaterial) return cached.handler;

  const signingKey =
    keyMaterial.length > 0 ? await sha256Key(keyMaterial) : crypto.getRandomValues(new Uint8Array(32));

  const registry = buildRegistry(new FunctionRegistry());
  const catalogInterface = new OpenMeteoCatalog(openMeteoCatalog, registry);
  const composite = new CompositeCatalogInterface([catalogInterface]);

  const handler = createVgiFetch({
    protocol: { registry, catalogInterface: composite },
    signingKey,
    tokenTtl: env.VGI_TOKEN_TTL ? Number(env.VGI_TOKEN_TTL) : 3600,
    // Serve RPC (and GET /health) at the root, matching the Bun entry.
    prefix: "",
    // Only to narrow the origin per-deployment. Since vgi 0.27.0 an omitted
    // corsOrigins defaults to "*" rather than disabling CORS outright, which is
    // what this Worker shipped with before — the Bun entry had always defaulted
    // open, so the gap was invisible until Cupola (cross-origin) hit a preflight
    // that came back as a bare 204. Leaving this unset is now the correct open
    // default; pass `null` to turn CORS off.
    corsOrigins: env.VGI_HTTP_CORS_ORIGINS,
    serverId: "vgi-open-meteo",
    repositoryUrl: "https://github.com/Query-farm/vgi-open-meteo",
    // Without landingInfo the handler falls back to vgi-rpc's generic "this is
    // an RPC endpoint" placeholder and stops serving /vgi-client.js, so the
    // shared landing page — catalog tree, Cupola CTA, ATTACH snippet — never
    // mounts. The Bun entry gets this for free because serveVgiWorker builds it
    // from its required name/doc/version; the CF entry has to pass it.
    landingInfo: {
      name: "open-meteo",
      doc: "Query the Open-Meteo weather API family from DuckDB as SQL table functions.",
      version: WORKER_VERSION,
    },
  });
  cached = { key: keyMaterial, handler };
  return handler;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handler = await getHandler(env);
    return handler(request);
  },
};
