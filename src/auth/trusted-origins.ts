/**
 * The `trustedOrigins` allowlist for Better Auth.
 *
 * This list is load-bearing for two separate defences, which is why it gets its own
 * tested module rather than being assembled inline in the config:
 *
 *  1. **CSRF.** Better Auth validates the `Origin` header of state-changing auth
 *     requests against it. Once the session cookie is `SameSite=None` (which it must
 *     be for a cross-origin SPA — see `security-posture.ts`), the browser will attach
 *     that cookie to cross-site requests, and this list is what stops an attacker's
 *     page from riding it.
 *  2. **Redirect targets.** `callbackURL` on the social sign-in and link flows is
 *     validated against the same list, so an entry here is also a permitted
 *     open-redirect destination.
 *
 * The bug fixed here: `http://localhost`, `http://localhost:5173` and
 * `http://localhost:5174` were pushed unconditionally, production included. Both
 * defences were therefore extended to any page able to occupy a localhost port on a
 * victim's machine — a second app, a malicious local dev server, a compromised
 * Electron bundle. All three are plain-http development origins, so they are now
 * scoped to non-TLS deployments, which is exactly where a local Vite dev server
 * lives.
 *
 * The NATIVE origins are not scoped that way and must stay in every environment, or
 * the mobile apps cannot sign in. Which origins those are is a property of
 * `Lopay/capacitor.config.json`, and it is worth being precise because guessing
 * costs either a broken app or a needlessly wide allowlist:
 *
 *  - **iOS** serves the bundle from `capacitor://localhost`.
 *  - **Android** serves it from `https://localhost`, because that config sets
 *    `server.androidScheme: "https"` (also Capacitor's default since v5). It is
 *    specifically NOT `http://localhost` — trusting the http spelling would widen
 *    the CSRF surface in production for a native origin this app never uses.
 *
 * Neither native origin carries the risk the http dev entries do: a browser will not
 * issue requests from `capacitor://`, and reaching `https://localhost` requires a
 * locally-trusted certificate rather than merely binding a port.
 */

/** Origins of the Capacitor native shells. Required in every environment. */
export const NATIVE_ORIGINS: readonly string[] = Object.freeze([
  'capacitor://localhost', // iOS
  'https://localhost', // Android (server.androidScheme: "https")
]);

/** Plain-http development origins — Vite dev server. Non-TLS deployments only. */
export const LOCAL_DEV_ORIGINS: readonly string[] = Object.freeze([
  'http://localhost',
  'http://localhost:5173',
  'http://localhost:5174',
]);

export interface TrustedOriginsInput {
  /** Raw `CORS_ORIGINS` — comma-separated. The deployment's real web origins. */
  corsOrigins?: string | undefined;
  /** Raw `BETTER_AUTH_URL` — this API's own origin. */
  betterAuthUrl?: string | undefined;
  /**
   * From `SecurityPosture.httpsDeployment`. When true the localhost dev origins are
   * withheld; the native origin is kept regardless.
   */
  httpsDeployment: boolean;
}

/**
 * Build the allowlist. Entries are de-duplicated while preserving first-seen order,
 * so a value repeated between `CORS_ORIGINS` and `BETTER_AUTH_URL` appears once and
 * the list stays stable enough to assert on.
 */
export function buildTrustedOrigins(input: TrustedOriginsInput): string[] {
  const configured = (input.corsOrigins ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const origins = [...configured, ...NATIVE_ORIGINS];

  if (!input.httpsDeployment) {
    origins.push(...LOCAL_DEV_ORIGINS);
  }

  const selfOrigin = input.betterAuthUrl?.trim();
  if (selfOrigin) origins.push(selfOrigin);

  return [...new Set(origins)];
}
