import {
  HANDOFF_NEXT_PARAM,
  resolveReturnOrigin,
  HANDOFF_TOKEN_PARAM,
  buildApiHandoffCallbackUrl,
  buildAppErrorUrl,
  buildAppHandoffUrl,
  buildAppLinkErrorUrl,
  sanitizeNextPath,
} from './oauth-handoff';

/**
 * The URLs a cross-site OAuth round trip travels through.
 *
 * Three properties are under test, and the sign-in is broken — or unsafe — if
 * any of them lapses.
 *
 * **The callback must stay on the API's origin.** That is the single line that
 * keeps the OAuth state and session cookies first-party, and therefore the
 * whole reason this flow works in Safari and Firefox where the previous one
 * could not.
 *
 * **The handoff token must stay inside the fragment.** It exchanges for a full
 * session. In a query string it would be written to this API's access log, the
 * browser's history and any `Referer` — so the placement is asserted as a
 * literal rather than inferred.
 *
 * **`next` must never become an open redirect.** It arrives in the query
 * string of a request any stranger can make and is echoed into a `Location`
 * header, so the sweep below is deliberately adversarial rather than
 * illustrative.
 */
describe('oauth handoff URLs', () => {
  const API = 'https://api.lopay.test';
  const WEB = 'https://app.lopay.test';
  const TOKEN = 'one-time-handoff-token-0123456789';

  describe('sanitizeNextPath', () => {
    it('accepts the in-app routes this app actually has', () => {
      for (const path of [
        '/dashboard',
        '/school-owner-dashboard',
        '/history',
        '/profile',
        '/school/invites',
        '/',
      ]) {
        expect(sanitizeNextPath(path)).toBe(path);
      }
    });

    it.each([
      // Protocol-relative: satisfies "starts with a slash" and leaves the site.
      ['//evil.test', 'protocol-relative'],
      ['//evil.test/path', 'protocol-relative with a path'],
      // Absolute URLs in every shape that has been used to slip one past a
      // naive "does it start with /" check.
      ['https://evil.test', 'absolute https'],
      ['http://evil.test', 'absolute http'],
      ['javascript:alert(1)', 'javascript scheme'],
      ['/\\evil.test', 'backslash smuggling'],
      ['/%2f%2fevil.test', 'percent-encoded protocol-relative'],
      ['\t//evil.test', 'leading control character'],
      // Traversal never addresses a hash route and only obscures a log.
      ['/../../etc/passwd', 'traversal'],
      // Relative paths cannot be echoed into a Location header safely.
      ['dashboard', 'no leading slash'],
      ['', 'empty'],
      ['   ', 'whitespace only'],
    ])('rejects %s (%s)', (candidate) => {
      expect(sanitizeNextPath(candidate)).toBeNull();
    });

    it('rejects a query string, so a claim token can never ride along', () => {
      // The route a parent is most likely resuming is the invite claim screen,
      // whose path carries a bearer token as `?token=…`. Allowing a query here
      // would march it through a top-level navigation to this API and write it
      // into our own access log — undoing the reason `claim-url.ts` puts it in
      // a fragment. The web client holds it in sessionStorage instead.
      expect(sanitizeNextPath('/claim-invite?token=secret')).toBeNull();
      expect(sanitizeNextPath('/dashboard#/elsewhere')).toBeNull();
    });

    it('rejects anything that is not a string, and anything over-long', () => {
      for (const junk of [undefined, null, 42, {}, [], true]) {
        expect(sanitizeNextPath(junk)).toBeNull();
      }
      expect(sanitizeNextPath(`/${'a'.repeat(200)}`)).toBeNull();
    });

    it('trims surrounding whitespace rather than rejecting on it', () => {
      expect(sanitizeNextPath('  /dashboard  ')).toBe('/dashboard');
    });
  });

  describe('resolveReturnOrigin', () => {
    // The same list Better Auth validates `callbackURL` against, which is why
    // this reuses it rather than inventing a parallel one that could drift.
    const TRUSTED = [WEB, 'https://localhost', 'capacitor://localhost', API];

    it('lets a trusted client name itself', () => {
      expect(resolveReturnOrigin(WEB, TRUSTED, WEB)).toBe(WEB);
      // Android's shell. Without this a native sign-in ends in a browser on the
      // web build rather than back in the app it started from.
      expect(resolveReturnOrigin('https://localhost', TRUSTED, WEB)).toBe(
        'https://localhost',
      );
    });

    it("matches iOS's capacitor:// origin, which does not parse to one", () => {
      // `new URL('capacitor://localhost').origin` is the string "null" — the
      // scheme is not special — so this entry has to match on its literal.
      expect(resolveReturnOrigin('capacitor://localhost', TRUSTED, WEB)).toBe(
        'capacitor://localhost',
      );
    });

    it('normalises before comparing, so a trailing slash still matches', () => {
      expect(resolveReturnOrigin(`${WEB}/`, TRUSTED, WEB)).toBe(WEB);
    });

    it.each([
      ['https://evil.test', 'an untrusted origin'],
      ['https://localhost.evil.test', 'a prefix-collision domain'],
      ['https://app.lopay.test.evil.test', 'a suffix-collision domain'],
      ['not a url', 'an unparseable value'],
      ['', 'an empty string'],
      ['null', 'the literal string null — capacitor:// parses to this'],
    ])('falls back for %s (%s)', (candidate) => {
      // Falling back rather than refusing: the value is echoed into a Location
      // header, so it must not become a redirect target — but a stale or
      // mistyped origin should still reach the real app, not an error page.
      expect(resolveReturnOrigin(candidate, TRUSTED, WEB)).toBe(WEB);
    });

    it('falls back for anything that is not a string', () => {
      for (const junk of [undefined, null, 42, {}, []]) {
        expect(resolveReturnOrigin(junk, TRUSTED, WEB)).toBe(WEB);
      }
    });
  });

  describe('buildApiHandoffCallbackUrl', () => {
    it("points at the API's own origin, never the web client's", () => {
      // The property the whole fix rests on. If this ever returns a WEB url,
      // the session cookie becomes third-party again and Safari/Firefox break.
      const url = buildApiHandoffCallbackUrl(API, '/dashboard');
      expect(url.startsWith(`${API}/`)).toBe(true);
      expect(url).not.toContain(WEB);
    });

    it('carries next when there is one, and omits it cleanly when there is not', () => {
      expect(buildApiHandoffCallbackUrl(API, '/dashboard')).toBe(
        `${API}/api/v1/auth/google/finish?${HANDOFF_NEXT_PARAM}=%2Fdashboard`,
      );
      expect(buildApiHandoffCallbackUrl(API, null)).toBe(
        `${API}/api/v1/auth/google/finish`,
      );
      // The return origin rides along so `finish` knows which client started
      // the flow — the round trip through Google loses everything else.
      expect(buildApiHandoffCallbackUrl(API, null, 'https://localhost')).toBe(
        `${API}/api/v1/auth/google/finish?return_to=${encodeURIComponent('https://localhost')}`,
      );
    });

    it('tolerates a trailing slash on the configured origin', () => {
      expect(buildApiHandoffCallbackUrl(`${API}/`, null)).toBe(
        `${API}/api/v1/auth/google/finish`,
      );
    });
  });

  describe('buildAppHandoffUrl', () => {
    it('puts the token after the # so it is never transmitted', () => {
      const url = buildAppHandoffUrl(WEB, TOKEN, null);
      expect(url).toBe(
        `${WEB}/#/auth/callback?${HANDOFF_TOKEN_PARAM}=${TOKEN}`,
      );

      // Stated as a property too, because the literal above is easy to "fix"
      // in the wrong direction: everything carrying the token must sit after
      // the first '#', which is the part a browser keeps to itself.
      const hashIndex = url.indexOf('#');
      expect(hashIndex).toBeGreaterThan(-1);
      expect(url.slice(0, hashIndex)).not.toContain(TOKEN);
    });

    it('keeps next alongside the token, still inside the fragment', () => {
      const url = buildAppHandoffUrl(WEB, TOKEN, '/school/invites');
      expect(url.slice(url.indexOf('#'))).toContain(
        `${HANDOFF_NEXT_PARAM}=%2Fschool%2Finvites`,
      );
      expect(url.slice(0, url.indexOf('#'))).toBe(`${WEB}/`);
    });
  });

  describe('error URLs', () => {
    it('always returns the visitor to the app, never to this API', () => {
      // The dead end being removed: without an errorCallbackURL Better Auth
      // drops the visitor on `${baseURL}/api/auth/error`, a bare page on a
      // domain they have never seen with no route back into the product.
      expect(buildAppErrorUrl(WEB, 'state_mismatch')).toBe(
        `${WEB}/#/auth?error=state_mismatch`,
      );
      expect(buildAppLinkErrorUrl(WEB, 'unable_to_link_account')).toBe(
        `${WEB}/#/profile?error=unable_to_link_account`,
      );
    });

    it('encodes a code rather than trusting it to be URL-safe', () => {
      expect(buildAppErrorUrl(WEB, "email_doesn't_match")).toBe(
        `${WEB}/#/auth?error=email_doesn%27t_match`,
      );
    });
  });
});
