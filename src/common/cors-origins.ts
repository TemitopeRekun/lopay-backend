/**
 * The CORS allowlist for the HTTP layer.
 *
 * Extracted from `bootstrap()` for the same reason `auth/trusted-origins.ts` was
 * extracted from the Better Auth config: it is a security boundary whose failure
 * mode is invisible from the web client, so it needs to be asserted on directly.
 *
 * The two lists are related but NOT interchangeable, and conflating them is what
 * broke the release APK:
 *
 *   - `trustedOrigins` is checked by Better Auth *inside* the request handler
 *     (CSRF + redirect targets).
 *   - This list is what produces the `Access-Control-Allow-Origin` response
 *     header. The browser enforces it *before* dispatching, so an origin missing
 *     here never reaches the handler at all — the WebView blocks the preflight
 *     and the client sees an opaque network failure with no status code to
 *     distinguish it from the server being down.
 *
 * The Capacitor native origins are therefore joined into BOTH, unconditionally.
 * They are a property of the app bundle (`Lopay/capacitor.config.json`), not of
 * the deployment, so they must not depend on each environment remembering to
 * append them to `CORS_ORIGINS` — that variable also seeds the notification
 * deep-link base URL, so overloading it has unrelated side effects.
 *
 * See `NATIVE_ORIGINS` in auth/trusted-origins.ts, which owns the values and
 * documents why Android's spelling is `https://localhost` rather than the http
 * one.
 */
import { NATIVE_ORIGINS } from '../auth/trusted-origins';

export interface CorsAllowlist {
  /**
   * Value for `enableCors({ origin })`. `true` reflects any origin (dev-only
   * convenience), `false` disables cross-origin access entirely.
   */
  origin: string[] | boolean;
  /**
   * Value for `enableCors({ credentials })`. Only ever true alongside an explicit
   * allowlist — `credentials: true` with a reflected origin would let any site
   * read authenticated responses.
   */
  credentials: boolean;
}

/**
 * @param corsOriginsRaw comma-separated `CORS_ORIGINS`
 * @param nodeEnv `NODE_ENV`; only `development` may fall back to reflecting
 */
export function resolveCorsAllowlist(
  corsOriginsRaw: string | undefined,
  nodeEnv: string | undefined,
): CorsAllowlist {
  const configured = (corsOriginsRaw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Nothing configured: reflect in development, refuse everywhere else. The
  // native origins are deliberately NOT added to the closed case — an
  // unconfigured production deploy stays fully closed rather than silently
  // serving two origins.
  if (configured.length === 0) {
    return {
      origin: (nodeEnv ?? 'development') === 'development',
      credentials: false,
    };
  }

  return {
    origin: [...new Set([...configured, ...NATIVE_ORIGINS])],
    credentials: true,
  };
}
