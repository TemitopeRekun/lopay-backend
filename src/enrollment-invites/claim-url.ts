/**
 * The shape of the link a school sends a parent.
 *
 * One module for both halves — how the link is built and how a token is read
 * back out of it — because they are a single format and a format with two
 * independent copies is a format that drifts. The server builds; the e2e suite
 * and the web client read. The web client's mirror is `utils/claimUrl.ts`.
 *
 * ## The link must be `/#/claim-invite?token=…`
 *
 * The web app mounts `<HashRouter>` (App.tsx), so every in-app location lives
 * *inside* the URL fragment: `https://app/#/history`, never
 * `https://app/history`. A link that puts the route in the real path never
 * reaches the app at all — the SPA fallback serves index.html, the router then
 * reads an empty (or unrelated) fragment, matches no route, and the visitor
 * lands on a blank screen. `NotificationsService.buildPushMessage` states the
 * same rule for push click targets, and this is the second place that has to
 * obey it.
 *
 * Both shapes that look reasonable are wrong, and were verified so against a
 * real `HashRouter`:
 *
 *   - `/claim-invite?token=…`  → no route match
 *   - `/claim-invite#token=…`  → no route match
 *   - `/#/claim-invite?token=…` → matches, `search` is `?token=…`
 *
 * ## Why that shape is also the private one
 *
 * The token is a bearer credential, and the rest of the feature is careful with
 * it: claim and dispute take it in a request BODY, and `preview` takes it in a
 * request HEADER precisely because a GET has no body. A link is the one place
 * it has to sit in a URL — so it sits after the `#`.
 *
 * Everything following a `#` is a fragment, and a fragment is never
 * transmitted. The browser requests `GET /` and keeps the rest to itself, so
 * the token reaches no access log and no `Referer`. That the router then parses
 * part of that fragment as a query string is a routing detail; it is still
 * fragment as far as the wire is concerned. This is the same reason OAuth's
 * implicit flow returned tokens after a `#`.
 *
 * What remains is the parent's own address bar, their history, and the WhatsApp
 * message itself — inherent to sending someone a link, and not something an
 * encoding can fix. Scrubbing it after a claim would buy nothing: the token is
 * single-use, so by then it is spent.
 */

/** Route the claim screen is mounted at, inside the hash. */
const CLAIM_ROUTE = '/claim-invite';

/** Query parameter the token travels in, within the fragment. */
export const CLAIM_TOKEN_PARAM = 'token';

/**
 * The claim link for `rawToken`, rooted at the web client's `origin`.
 *
 * The literal shape is asserted in `claim-url.spec.ts` and mirrored by the web
 * client's `claimUrl.test.ts`; both carry a note pointing at the other, because
 * a change to one side alone produces a link that silently reaches nothing.
 */
export function buildClaimUrl(origin: string, rawToken: string): string {
  const query = new URLSearchParams({ [CLAIM_TOKEN_PARAM]: rawToken });
  return `${origin}/#${CLAIM_ROUTE}?${query.toString()}`;
}

/**
 * Read the token back out of a claim link, or null if it carries none.
 *
 * Deliberately parses the FRAGMENT and nothing else. A link whose token sits in
 * the real query string (`/claim-invite?token=…`, the shape this format
 * replaced) yields null rather than working, because such a link both fails to
 * route and leaks the token to the server — quietly accepting it would hide
 * both faults.
 *
 * Validation of the token's *shape* is not done here: that belongs to
 * `hashInviteToken`, the one place that decides what a real token looks like.
 */
export function parseClaimUrlToken(claimUrl: string): string | null {
  const hashIndex = claimUrl.indexOf('#');
  if (hashIndex === -1) return null;

  const fragment = claimUrl.slice(hashIndex + 1);
  const queryIndex = fragment.indexOf('?');
  if (queryIndex === -1) return null;

  return new URLSearchParams(fragment.slice(queryIndex + 1)).get(
    CLAIM_TOKEN_PARAM,
  );
}
