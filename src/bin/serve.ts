// HTTP server entry point for the Open-Meteo worker.
//
// Designed for deployment behind a load balancer (Cloud Run / Fly): per-request
// state is round-tripped through HMAC-signed state tokens, so the worker is
// stateless across requests.

import {
  arrowStateSerializer,
  buildVgiProtocol,
  CompositeCatalogInterface,
  FunctionRegistry,
} from "vgi";
import {
  createHttpHandler,
  unpackStateToken,
  type AuthenticateFn,
  type OAuthResourceMetadata,
} from "vgi-rpc";

import { buildRegistry, openMeteoCatalog, OpenMeteoCatalog } from "../catalog.js";
import { idTokenAuthenticate } from "../auth.js";

const PORT = Number(process.env.VGI_HTTP_PORT ?? process.env.PORT ?? 8000);
const HOST = process.env.VGI_HTTP_HOST ?? "0.0.0.0";
// Default to the root path (no prefix). Set VGI_HTTP_PREFIX to mount elsewhere.
const PREFIX = process.env.VGI_HTTP_PREFIX ?? "";
const TOKEN_TTL = Number(process.env.VGI_TOKEN_TTL ?? 3600);

// Stable key for sealing state tokens. State tokens are now XChaCha20-Poly1305
// AEAD-sealed (not HMAC-signed), so this is the 32-byte master encryption key.
// In production set VGI_SIGNING_KEY to a stable secret; for local dev we
// generate a random one per process.
async function resolveTokenKey(): Promise<Uint8Array> {
  const env = process.env.VGI_SIGNING_KEY;
  if (env && env.length > 0) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env));
    return new Uint8Array(digest);
  }
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  process.stderr.write(
    "[vgi-open-meteo] WARNING: VGI_SIGNING_KEY not set, generated a random ephemeral key — state tokens won't survive restart.\n",
  );
  return random;
}

const tokenKey = await resolveTokenKey();

// ---------------------------------------------------------------------------
// Optional JWT/OAuth auth. The TS framework doesn't auto-consume env vars (the
// Python `vgi` did), so we replicate the same `VGI_JWT_*` / `VGI_OAUTH_*`
// contract here: when VGI_JWT_ISSUER + VGI_JWT_AUDIENCE are set, every RPC
// request must carry a valid Bearer JWT (the handler returns 401 +
// WWW-Authenticate otherwise). When VGI_OAUTH_RESOURCE is also set, the
// matching RFC 9728 Protected Resource Metadata is served at the well-known
// endpoint and the PKCE browser-login flow is enabled. Unset → open, as before.
// ---------------------------------------------------------------------------
const csv = (v: string | undefined): string[] | undefined =>
  v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

function buildAuth(): {
  authenticate?: AuthenticateFn;
  oauthResourceMetadata?: OAuthResourceMetadata;
} {
  const issuer = process.env.VGI_JWT_ISSUER;
  const audience = csv(process.env.VGI_JWT_AUDIENCE);
  if (!issuer || !audience || audience.length === 0) return {};

  const authenticate = idTokenAuthenticate({
    issuer,
    audience,
    jwksUri: process.env.VGI_JWT_JWKS_URI,
  });

  let oauthResourceMetadata: OAuthResourceMetadata | undefined;
  const resource = process.env.VGI_OAUTH_RESOURCE;
  if (resource) {
    oauthResourceMetadata = {
      resource,
      authorizationServers: csv(process.env.VGI_OAUTH_AUTH_SERVERS) ?? [issuer],
      scopesSupported: csv(process.env.VGI_OAUTH_SCOPES),
      resourceName: process.env.VGI_OAUTH_RESOURCE_NAME,
      clientId: process.env.VGI_OAUTH_CLIENT_ID,
      clientSecret: process.env.VGI_OAUTH_CLIENT_SECRET,
      deviceCodeClientId: process.env.VGI_OAUTH_DEVICE_CODE_CLIENT_ID,
      deviceCodeClientSecret: process.env.VGI_OAUTH_DEVICE_CODE_CLIENT_SECRET,
      useIdTokenAsBearer: process.env.VGI_OAUTH_USE_ID_TOKEN === "true",
    };
  }
  return { authenticate, oauthResourceMetadata };
}

const auth = buildAuth();

const registry = buildRegistry(new FunctionRegistry());

const catalogInterface = new OpenMeteoCatalog(openMeteoCatalog, registry);
const composite = new CompositeCatalogInterface([catalogInterface]);

const protocol = buildVgiProtocol({
  registry,
  catalogInterface: composite,
  recoverExchangeState: async (opaqueData: Uint8Array) => {
    const tokenString = new TextDecoder().decode(opaqueData);
    // No authenticate callback → all requests are anonymous, so the token's
    // AEAD AAD is bound to the anonymous principal (pass undefined to match).
    const unpacked = await unpackStateToken(tokenString, tokenKey, TOKEN_TTL, undefined);
    return arrowStateSerializer.deserialize(unpacked.stateBytes);
  },
});

const vgiHandler = createHttpHandler(protocol, {
  prefix: PREFIX,
  serverId: "vgi-open-meteo",
  tokenKey,
  tokenTtl: TOKEN_TTL,
  stateSerializer: arrowStateSerializer,
  corsOrigins: process.env.VGI_HTTP_CORS_ORIGINS,
  ...auth,
});

// The framework serves the Cloud Run / Fly liveness probe itself: GET
// {PREFIX}/health returns 200 JSON, is exempt from auth, and (unlike a custom
// wrapper) carries the configured CORS headers. With PREFIX="" that's /health,
// matching fly.toml's health check. We therefore hand requests straight to the
// VGI handler rather than intercepting /health (which would drop CORS).
const server = Bun.serve({ port: PORT, hostname: HOST, fetch: vgiHandler });
process.stderr.write(
  `[vgi-open-meteo] listening on http://${HOST}:${server.port}${PREFIX} ` +
    `(auth: ${auth.authenticate ? "JWT required" : "open"})\n`,
);
