/**
 * The URLs a cross-site OAuth round trip travels through, as pure functions.
 *
 * Nothing here touches Nest, Prisma, Better Auth or `process.env`. That is
 * deliberate, and for the same reason `enrollment-invites/invite-policy.ts` is:
 * these are the decisions worth sweeping exhaustively — what counts as a safe
 * return path, where a bearer credential is allowed to sit in a URL — and they
 * are only cheap to sweep while they stay free of I/O.
 *
 * ## The shape of the round trip
 *
 * Five hops, and the interesting property is that a cookie only ever has to
 * survive between hops that share an origin:
 *
 *   1. SPA  → `GET {api}/api/v1/auth/google/start?next=/dashboard`
 *             a TOP-LEVEL navigation, so the OAuth state cookie this sets is
 *             first-party on the API's own origin.
 *   2. API  → Google.
 *   3. Google → `GET {api}/api/auth/callback/google`, still the API's origin, so
 *             the state cookie from hop 1 is a first-party read and the CSRF
 *             check Better Auth performs on it is fully intact.
 *   4. API  → `GET {api}/api/v1/auth/google/finish`, same origin again, so the
 *             session cookie just written is readable; it is exchanged here for
 *             a one-time token.
 *   5. API  → `{web}/#/auth/callback?ott=…`, and the SPA trades the token for a
 *             bearer session over ordinary CORS.
 *
 * No cookie crosses a site boundary at any point, which is the whole objective:
 * the previous design needed one to, and Safari's ITP, Firefox's Total Cookie
 * Protection and Chrome's incognito mode each independently guaranteed it would
 * not arrive.
 *
 * ## Why the token sits after the `#`
 *
 * Everything following a `#` is a fragment, and a fragment is never
 * transmitted: the browser requests `{web}/` and keeps the rest to itself, so
 * the token reaches no access log, no `Referer` and no proxy. This is the same
 * argument `enrollment-invites/claim-url.ts` makes for the claim link, and the
 * same reason OAuth's implicit flow returned tokens after a `#`. It is also why
 * the app being hash-routed costs nothing here — the SPA parses the fragment
 * client-side, which is the only place the value ever exists.
 */

/** Query parameter the one-time handoff token travels in, within the fragment. */
export const HANDOFF_TOKEN_PARAM = 'ott';

/** Query parameter carrying the in-app route to resume on. */
export const HANDOFF_NEXT_PARAM = 'next';

/**
 * Query parameter naming the client origin to return to.
 *
 * Present so the Capacitor shells get back into the app they started from
 * rather than being dropped on the web build. Always re-validated through
 * `resolveReturnOrigin`; never trusted as it arrives.
 */
export const HANDOFF_RETURN_PARAM = 'return_to';

/** Query parameter Better Auth appends when a redirect-half failure occurs. */
export const HANDOFF_ERROR_PARAM = 'error';

/** Route the web client mounts its handoff screen at, inside the hash. */
const APP_CALLBACK_ROUTE = '/auth/callback';

/** Where a failed sign-in returns to. The sign-in form, which renders the code. */
const APP_AUTH_ROUTE = '/auth';

/** Longest `next` we will echo back. Comfortably past any route this app has. */
const MAX_NEXT_LENGTH = 128;

/**
 * An in-app route, and nothing else.
 *
 * Anchored, and deliberately far narrower than "a valid URL path". The value
 * arrives in the query string of a request an unauthenticated stranger can make
 * and is echoed into a `Location` header, which is the exact shape of an open
 * redirect — so the rule is an allow-list of characters rather than a
 * blocklist of the tricks people use (`//evil.com`, `/\evil.com`,
 * `https://evil.com`, `/%2f%2fevil.com`, a `\t` smuggled into the scheme).
 *
 * Note what is excluded and why it matters beyond redirects: `?` and `#`. The
 * one route a parent is most likely to be resuming is the enrollment-invite
 * claim screen, whose path carries a bearer token as `?token=…`. Permitting a
 * query string here would march that token through a top-level navigation to
 * this API and write it into our own access log — undoing the entire reason
 * `claim-url.ts` puts it in a fragment. The web client does not need it to:
 * `utils/pendingInvite.ts` already holds the token in `sessionStorage`, which
 * survives the redirect because it is the same tab on the same origin, and the
 * handoff screen reads it back from there.
 */
const SAFE_NEXT_PATH = /^\/[A-Za-z0-9\-._~/]*$/;

/**
 * The in-app path to resume on, or null when the caller supplied nothing usable.
 *
 * Returns null rather than throwing, and rather than falling back to a default,
 * because the two callers want different things from "unusable": the start
 * route simply omits it, and a null here must never be the reason a sign-in
 * fails. A rejected value is dropped silently on purpose — telling a prober
 * which of their payloads was structurally interesting is the only thing an
 * error message here could achieve.
 */
export function sanitizeNextPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_NEXT_LENGTH) return null;

  // `//evil.com` is a protocol-relative URL: it satisfies "starts with a slash"
  // and navigates off-site. Checked explicitly because the character class
  // above would otherwise accept it.
  if (trimmed.startsWith('//')) return null;

  // `/..%2f` and friends never address a route in a hash router; refusing them
  // keeps the value something a human can read in a log.
  if (trimmed.includes('..')) return null;

  return SAFE_NEXT_PATH.test(trimmed) ? trimmed : null;
}

/**
 * Which origin the finished sign-in should return to.
 *
 * ## Why this is not simply `WEB_APP_URL`
 *
 * Because the web client is not the only client. The Capacitor shells serve
 * the same app from their own origins — `https://localhost` on Android and
 * `capacitor://localhost` on iOS (see `trusted-origins.ts`) — and a sign-in
 * that always redirected to the Netlify site would walk a native user out of
 * their app and leave them in a browser, signed in to a copy they did not
 * start from. The caller therefore says where it is, and this decides whether
 * to believe it.
 *
 * ## Why it is checked against `trustedOrigins` specifically
 *
 * That list already IS the set of permitted redirect destinations: Better Auth
 * validates `callbackURL` against it on exactly these flows, and
 * `trusted-origins.ts` says so in as many words. Inventing a second, parallel
 * allow-list here would be a list that could drift out of step with the one the
 * framework enforces — and the failure mode of drift is an open redirect.
 *
 * Anything unrecognised falls back to `fallback` rather than being refused. A
 * mistyped or stale origin should send someone to the real web app, not strand
 * them on an error for a parameter they never typed.
 */
export function resolveReturnOrigin(
  requested: unknown,
  trustedOrigins: readonly string[],
  fallback: string,
): string {
  if (typeof requested !== 'string' || !requested.trim()) return fallback;

  const candidate = requested.trim();

  // Compared as parsed ORIGINS, never as strings. `https://localhost` and
  // `https://localhost/` are the same origin and a string compare says
  // otherwise; `https://localhost.evil.test` is a different one and a
  // `startsWith` compare says otherwise, which is the dangerous direction.
  let normalized: string;
  try {
    normalized = new URL(candidate).origin;
  } catch {
    return fallback;
  }

  // `capacitor://localhost` parses to an origin of "null" in the WHATWG sense
  // (the scheme is not special), so the native iOS entry has to be matched on
  // the literal it is declared as rather than through `URL.origin`.
  const match = trustedOrigins.find((trusted) => {
    if (trusted === candidate) return true;
    try {
      return new URL(trusted).origin === normalized && normalized !== 'null';
    } catch {
      return false;
    }
  });

  return match ?? fallback;
}

/**
 * Where Google's callback should land once Better Auth has built the session.
 *
 * An API-origin URL, not the web client's. That is the point: it keeps hop 4 on
 * the same origin as hop 3, so the session cookie written by the callback is a
 * first-party read when the handoff route asks for it. Pointing this at the SPA
 * — which is what the original implementation did — is precisely what forced
 * the session to travel as a third-party cookie.
 */
export function buildApiHandoffCallbackUrl(
  apiOrigin: string,
  next: string | null,
  returnOrigin?: string,
): string {
  const url = `${trimTrailingSlash(apiOrigin)}/api/v1/auth/google/finish`;
  const query = new URLSearchParams();
  if (next) query.set(HANDOFF_NEXT_PARAM, next);
  // Carried through the round trip so `finish` knows which client started it.
  // It has already been validated by `resolveReturnOrigin`, and it is read back
  // through that same function on arrival rather than trusted — the URL makes a
  // visit to Google and back, so it is caller-controlled either way.
  if (returnOrigin) query.set(HANDOFF_RETURN_PARAM, returnOrigin);
  const qs = query.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * The redirect that hands a minted token back to the web client.
 *
 * The token goes inside the fragment — see the note at the top of this file on
 * why that is what keeps it off the wire.
 */
export function buildAppHandoffUrl(
  webOrigin: string,
  token: string,
  next: string | null,
): string {
  const query = new URLSearchParams({ [HANDOFF_TOKEN_PARAM]: token });
  if (next) query.set(HANDOFF_NEXT_PARAM, next);
  return `${trimTrailingSlash(webOrigin)}/#${APP_CALLBACK_ROUTE}?${query.toString()}`;
}

/**
 * Where a failure returns the visitor to: the sign-in screen, carrying a code.
 *
 * Always an app URL, never this API's own error page. A parent stranded on
 * `lopay-backend.onrender.com/api/auth/error` has no route back into the
 * product and no idea what happened — which is the dead end this whole change
 * exists to remove. The web client maps the code to wording in
 * `utils/validation/oauthRedirectErrors.ts`.
 */
export function buildAppErrorUrl(webOrigin: string, code: string): string {
  const query = new URLSearchParams({ [HANDOFF_ERROR_PARAM]: code });
  return `${trimTrailingSlash(webOrigin)}/#${APP_AUTH_ROUTE}?${query.toString()}`;
}

/**
 * Where a failed *link* returns to: the profile screen, which already renders
 * these codes (`hooks/useGoogleLink.ts`) and is where the user started.
 */
export function buildAppLinkErrorUrl(webOrigin: string, code: string): string {
  const query = new URLSearchParams({ [HANDOFF_ERROR_PARAM]: code });
  return `${trimTrailingSlash(webOrigin)}/#/profile?${query.toString()}`;
}

function trimTrailingSlash(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin;
}
