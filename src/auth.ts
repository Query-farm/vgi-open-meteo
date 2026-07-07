// Authentication for the HTTP server.
//
// Google (and OIDC providers generally) issue **id_tokens**, and with
// VGI_OAUTH_USE_ID_TOKEN=true the OAuth PKCE flow stores the id_token in the
// auth cookie. id_tokens are NOT RFC 9068 access tokens — they carry
// `typ: JWT` and lack the `jti`/`client_id` claims. The framework's
// `jwtAuthenticate()` validates via `validateJwtAccessToken`, which requires
// `typ: at+jwt` + those claims, so it rejects every id_token — manifesting as
// an endless redirect back to the provider's sign-in page. We instead verify
// the id_token directly against the issuer's JWKS.

import { createRemoteJWKSet, jwtVerify } from "jose";
import { AuthContext, type AuthenticateFn } from "vgi-rpc";

export interface IdTokenAuthOptions {
  issuer: string;
  audience: string[];
  /** Explicit JWKS URI. If omitted, discovered from the issuer's metadata. */
  jwksUri?: string;
  /** id_token claim used as the principal. Default: "sub". */
  principalClaim?: string;
  /** AuthContext domain label. Default: "oidc". */
  domain?: string;
}

export function idTokenAuthenticate(opts: IdTokenAuthOptions): AuthenticateFn {
  const principalClaim = opts.principalClaim ?? "sub";
  const domain = opts.domain ?? "oidc";
  // Google's id_token `iss` appears with or without the https:// scheme.
  const issuers = [opts.issuer, opts.issuer.replace(/^https:\/\//, "")];

  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (jwks) return jwks;
    let uri = opts.jwksUri;
    if (!uri) {
      const conf = (await fetch(
        new URL("/.well-known/openid-configuration", opts.issuer),
      ).then((r) => r.json())) as { jwks_uri?: string };
      uri = conf.jwks_uri;
      if (!uri) throw new Error(`No jwks_uri discovered for issuer ${opts.issuer}`);
    }
    jwks = createRemoteJWKSet(new URL(uri));
    return jwks;
  }

  return async function authenticate(request: Request): Promise<AuthContext> {
    const authz = request.headers.get("authorization");
    const [scheme, token] = (authz ?? "").split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw new Error("Missing or malformed Bearer token");
    }
    const { payload } = await jwtVerify(token, await getJwks(), {
      issuer: issuers,
      audience: opts.audience,
    });
    const principal = (payload[principalClaim] as string | undefined) ?? payload.sub ?? null;
    return new AuthContext(domain, true, principal, payload as Record<string, unknown>);
  };
}
