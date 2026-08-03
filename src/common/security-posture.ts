/**
 * The deployment's security posture, derived from what the deployment actually
 * *is* rather than from `NODE_ENV`.
 *
 * ## Why not NODE_ENV
 *
 * Every security-relevant switch in this service used to hang off
 * `NODE_ENV === 'production'`: the Swagger gate, HSTS, the API's own CSP, and the
 * `SameSite=None` session cookie. That coupling failed in the worst direction on
 * the Render deploy, which runs `NODE_ENV=development` deliberately — the Joi
 * schema in `app.module.ts` demands a LIVE Paystack key and a 64-hex
 * `ENCRYPTION_KEY` once `NODE_ENV=production`, so the staging-first deploy cannot
 * simply flip it. The result was a public internet host serving Swagger UI and the
 * full OpenAPI document at `/api` and `/api-json`, with no HSTS and no CSP.
 *
 * `NODE_ENV` answers "how should this build behave?" — how verbose to be, whether
 * to demand production-grade credentials. It cannot answer "is this host reachable
 * from the internet?", which is the only question that matters for the switches
 * below. So each one is now derived from a fact with the right shape:
 *
 *  - **Is this deployment served over TLS?** `BETTER_AUTH_URL` is already required
 *    and validated as a URI, and it is by definition the public origin of this
 *    API. An `https:` scheme there means real clients over the internet, which is
 *    exactly the condition under which HSTS matters and under which a
 *    `SameSite=None; Secure` cookie is both required (cross-origin SPA) and
 *    permitted (browsers drop `SameSite=None` without `Secure`). Local dev on
 *    `http://localhost:3001` keeps today's `Lax`/no-HSTS behaviour for free.
 *
 *  - **Should the API document itself?** An explicit `API_DOCS_ENABLED` opt-in.
 *    Defaulting to `false` inverts the old failure mode: forgetting to configure
 *    it now yields a *closed* door instead of an open one.
 *
 * Every field is a pure function of the environment, so `security-posture.spec.ts`
 * can pin the table of decisions without booting Nest.
 */

/**
 * The environment slice this module reads. The index signature is what lets a real
 * `process.env` be passed directly (TypeScript otherwise rejects an
 * index-signature type against an all-optional "weak" interface), while the named
 * members keep the contract self-documenting.
 */
export interface SecurityPostureEnv {
  BETTER_AUTH_URL?: string | undefined;
  API_DOCS_ENABLED?: string | undefined;
  CLIENT_IP_HEADER?: string | undefined;
  [key: string]: string | undefined;
}

export interface SecurityPosture {
  /**
   * The public origin of this API is `https:`. Stands in for "internet-facing",
   * because TLS is the one property a browser-facing deploy cannot fake.
   */
  httpsDeployment: boolean;
  /** Serve Swagger UI (`/api`) and the OpenAPI JSON (`/api-json`). */
  apiDocsEnabled: boolean;
  /** Send `Strict-Transport-Security`. */
  hsts: boolean;
  /**
   * The `Content-Security-Policy` for API responses, or `null` to send none.
   *
   * This service returns JSON only, so the strictest possible policy is also the
   * correct one — it is the last line of defence against any reflected-content
   * XSS, and replaces the deprecated `X-XSS-Protection`. It is withheld only when
   * the docs are enabled, because Swagger UI is HTML with inline assets that
   * `default-src 'none'` would blank out.
   */
  contentSecurityPolicy: string | null;
  /**
   * Issue session cookies as `SameSite=None; Secure; HttpOnly` so the SPA — a
   * different origin from the API — can send them on API and socket requests.
   * Requires TLS: browsers reject `SameSite=None` without `Secure`.
   */
  crossSiteCookies: boolean;
  /**
   * Lowercased name of the request header that carries the true client IP at this
   * deployment's edge, or `null` when the app is directly exposed and the socket
   * address is authoritative. See `client-ip.ts` for why this is an explicit
   * operator declaration rather than a guess.
   */
  clientIpHeader: string | null;
  /**
   * Whether the rate-limit key actually distinguishes one caller from another.
   *
   * True when either the operator has declared the edge's client-IP header, or the
   * deployment is not TLS-fronted (local development, where the socket address IS
   * the caller). False means every caller collapses into one bucket.
   *
   * This gates how tight the per-path credential budgets may be, and the reasoning
   * is worth stating because it looks like security being made conditional. It is
   * the opposite. A 10-per-minute cap on `/sign-in/email` is a brute-force control
   * when the key is per-caller; applied to a bucket shared by the whole internet it
   * becomes a denial-of-service *primitive* — an attacker spends ten requests a
   * minute and no parent can sign in at all. So a shared key gets the coarse flood
   * budget instead, and `app.module.ts` logs a startup warning naming the setting
   * that fixes it. See auth-rate-limit.ts.
   */
  trustedPerClientIp: boolean;
}

/** JSON-only API: the strictest policy that still describes this service. */
export const STRICT_API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Truthy-string parsing for boolean environment variables.
 *
 * Deliberately allowlist-based: anything unrecognised — including the string
 * `"false"`, an empty value, or a typo like `"ture"` — reads as `false`. A
 * security switch must never be enabled by a value nobody meant to be truthy.
 */
export function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** `https://api.example.com` → true. Malformed or unset → false (fail closed). */
export function isHttpsUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return new URL(raw.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Resolve the whole posture from the environment. */
export function resolveSecurityPosture(
  env: SecurityPostureEnv,
): SecurityPosture {
  const httpsDeployment = isHttpsUrl(env.BETTER_AUTH_URL);
  const apiDocsEnabled = parseBooleanEnv(env.API_DOCS_ENABLED);
  const clientIpHeader = env.CLIENT_IP_HEADER?.trim().toLowerCase();

  return {
    httpsDeployment,
    apiDocsEnabled,
    hsts: httpsDeployment,
    // Withheld only for Swagger's sake — see the field's docblock.
    contentSecurityPolicy: apiDocsEnabled ? null : STRICT_API_CSP,
    crossSiteCookies: httpsDeployment,
    clientIpHeader: clientIpHeader ? clientIpHeader : null,
    trustedPerClientIp: Boolean(clientIpHeader) || !httpsDeployment,
  };
}
