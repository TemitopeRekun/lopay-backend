import { buildClaimUrl, parseClaimUrlToken } from './claim-url';

/**
 * The link format, pinned from both ends.
 *
 * Two independent properties are under test, and the feature is broken if
 * either lapses.
 *
 * **It has to route.** The web app mounts `<HashRouter>`, so the in-app
 * location lives inside the fragment. A link with the route in the real path
 * reaches the SPA fallback, matches nothing, and shows a blank screen — which
 * is what both earlier drafts of this link did (`/claim-invite?token=…` and
 * `/claim-invite#token=…`). The mirror of this suite,
 * `Lopay/utils/claimUrl.test.ts`, mounts a real HashRouter at the URL this
 * builder produces; the literal below must stay in step with it.
 *
 * **It must not leak.** The token is a bearer credential. Everything after the
 * `#` is fragment and is never transmitted, so it reaches no access log and no
 * `Referer` — the reason the route sits there rather than in the path.
 */
describe('claim URL', () => {
  const ORIGIN = 'https://app.lopay.test';
  const TOKEN = 'Zm9vYmFyLXRva2VuLTEyMzQ1Njc4OTBhYmNkZWZnaGk';

  it('builds a hash-routed link with the token inside the fragment', () => {
    // Mirrored in Lopay/utils/claimUrl.test.ts — change both or neither.
    expect(buildClaimUrl(ORIGIN, TOKEN)).toBe(
      `${ORIGIN}/#/claim-invite?token=${TOKEN}`,
    );
  });

  it('puts nothing the browser transmits anywhere near the token', () => {
    const url = new URL(buildClaimUrl(ORIGIN, TOKEN));

    // The request line and everything in it. A fragment is stripped by the
    // browser before the request is made, so none of these may hold the token.
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/');
    expect(`${url.origin}${url.pathname}${url.search}`).not.toContain(TOKEN);
    // And the token is in the part that stays behind.
    expect(url.hash).toContain(TOKEN);
  });

  it('round-trips a token through build and parse', () => {
    expect(parseClaimUrlToken(buildClaimUrl(ORIGIN, TOKEN))).toBe(TOKEN);
  });

  it('round-trips a token containing URL-significant characters', () => {
    // base64url never produces these, but the format must not be the place a
    // malformed token turns into a broken link or an injected parameter.
    const awkward = 'a&b=c d#e+f';
    expect(parseClaimUrlToken(buildClaimUrl(ORIGIN, awkward))).toBe(awkward);
  });

  it.each([
    ['nothing', ''],
    ['an empty fragment', '#'],
    ['a fragment with no query', 'https://app/#/claim-invite'],
    ['a fragment carrying other keys', 'https://app/#/claim-invite?ref=wa'],
    ['a link with no fragment at all', 'https://app/claim-invite'],
  ])('reads no token from %s', (_label, input) => {
    expect(parseClaimUrlToken(input)).toBeNull();
  });

  it('refuses a token in the REAL query string rather than tolerating it', () => {
    // The shape this format replaced. It does not route, and it sends the
    // credential to whatever serves the SPA. Accepting it here would hide both
    // faults behind a parser that still worked.
    expect(parseClaimUrlToken('https://app/claim-invite?token=abc')).toBeNull();
  });
});
