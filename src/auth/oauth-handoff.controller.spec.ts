// `better-auth/node` is ESM-only and ts-jest loads this suite as CommonJS, so
// the import has to be stubbed before the controller is pulled in — the same
// treatment `better-auth.guard.spec.ts` gives it. The real function only
// reshapes a headers bag, which these tests do not exercise.
jest.mock('better-auth/node', () => ({
  fromNodeHeaders: (headers: unknown) => headers,
}));

import { OAuthHandoffController } from './oauth-handoff.controller';

/**
 * The redirect routes that carry a Google sign-in between two sites.
 *
 * What is worth pinning here is not the happy path — that is three lines of
 * delegation — but the four properties that were each, on their own, the whole
 * bug:
 *
 *  1. **The state cookie reaches the browser.** `signInSocial` is called
 *     through the API rather than the HTTP handler, so its `Set-Cookie` only
 *     arrives if this controller forwards it. Drop that and the callback has
 *     nothing to verify against and answers `state_mismatch` — the exact
 *     failure being fixed, reintroduced from the other side.
 *  2. **The callback points at the API, not the app.** The moment that becomes
 *     a web-origin URL the session cookie is third-party again.
 *  3. **Every failure lands in the app.** No path may leave a parent on this
 *     API's own error page.
 *  4. **A first Google link on a password account revokes older sessions.**
 *     That is the only thing standing between a pre-registered account and a
 *     silent co-tenant; a returning user must not trip it.
 */
describe('OAuthHandoffController', () => {
  const API = 'https://api.lopay.test';
  const WEB = 'https://app.lopay.test';

  const makeRes = () => {
    const appended: string[] = [];
    return {
      appended,
      redirected: [] as string[],
      append(_name: string, value: string) {
        appended.push(value);
      },
      redirect(url: string) {
        this.redirected.push(url);
      },
    };
  };

  const makeDeps = (overrides: {
    api?: Record<string, unknown>;
    accounts?: Array<{ providerId: string; createdAt: Date }>;
  }) => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 2 });
    const notify = jest.fn().mockResolvedValue(undefined);
    const auth = {
      api: {
        signInSocial: jest.fn().mockResolvedValue({
          headers: new Headers({ 'set-cookie': 'state=abc; Path=/' }),
          response: { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' },
        }),
        getSession: jest.fn().mockResolvedValue({ user: { id: 'user-1' } }),
        generateOneTimeToken: jest.fn().mockResolvedValue({ token: 'ott-1' }),
        verifyOneTimeToken: jest
          .fn()
          .mockResolvedValue({ session: { token: 'sess-1' } }),
        linkSocialAccount: jest.fn().mockResolvedValue({
          headers: new Headers({ 'set-cookie': 'state=def; Path=/' }),
          response: { url: 'https://accounts.google.com/link' },
        }),
        ...(overrides.api ?? {}),
      },
    };
    const prisma = {
      account: {
        findMany: jest.fn().mockResolvedValue(overrides.accounts ?? []),
      },
      session: { deleteMany },
    };
    const config = {
      get: (key: string) =>
        key === 'BETTER_AUTH_URL'
          ? API
          : key === 'WEB_APP_URL'
            ? WEB
            : key === 'CORS_ORIGINS'
              ? `${WEB},https://localhost`
              : undefined,
    };

    const controller = new OAuthHandoffController(
      auth as never,
      config as never,
      prisma as never,
      { create: notify } as never,
    );
    return { controller, auth, prisma, deleteMany, notify };
  };

  describe('start', () => {
    it('forwards the OAuth state cookie and redirects to Google', async () => {
      const { controller, auth } = makeDeps({});
      const res = makeRes();

      await controller.start('/dashboard', undefined, res as never);

      // Property 1. Without this the callback cannot verify state.
      expect(res.appended).toEqual(['state=abc; Path=/']);
      expect(res.redirected).toEqual([
        'https://accounts.google.com/o/oauth2/v2/auth?x=1',
      ]);

      // Property 2. The callback must come back to THIS origin.
      const body = auth.api.signInSocial.mock.calls[0][0].body as {
        callbackURL: string;
        errorCallbackURL: string;
      };
      expect(body.callbackURL).toBe(
        `${API}/api/v1/auth/google/finish?next=%2Fdashboard&return_to=${encodeURIComponent(WEB)}`,
      );
      // Handed over with no query of its own: Better Auth appends `?error=`.
      expect(body.errorCallbackURL).toBe(`${WEB}/#/auth`);
    });

    it('drops a next that is not an in-app path, rather than refusing to sign in', async () => {
      const { controller, auth } = makeDeps({});
      await controller.start('//evil.test', undefined, makeRes() as never);

      const body = auth.api.signInSocial.mock.calls[0][0].body as {
        callbackURL: string;
      };
      expect(body.callbackURL).toBe(
        `${API}/api/v1/auth/google/finish?return_to=${encodeURIComponent(WEB)}`,
      );
    });

    it('returns a Capacitor shell to its own origin, not the web build', async () => {
      // Android serves the bundle from `https://localhost`. Always redirecting
      // to the Netlify site would walk a native user out of their app and leave
      // them in a browser, signed in to a copy they did not start from.
      const { controller, auth } = makeDeps({});

      await controller.start(
        undefined,
        'https://localhost',
        makeRes() as never,
      );

      const body = auth.api.signInSocial.mock.calls[0][0].body as {
        callbackURL: string;
        errorCallbackURL: string;
      };
      expect(body.callbackURL).toContain(
        `return_to=${encodeURIComponent('https://localhost')}`,
      );
      expect(body.errorCallbackURL).toBe('https://localhost/#/auth');
    });

    it('falls back to the web app for an origin that is not trusted', async () => {
      // The parameter is echoed into a Location header, so an unrecognised
      // value must not become a redirect target. Falling back rather than
      // refusing: a stale origin should reach the real app, not an error page.
      const { controller, auth } = makeDeps({});

      await controller.start(
        undefined,
        'https://evil.test',
        makeRes() as never,
      );

      const body = auth.api.signInSocial.mock.calls[0][0].body as {
        errorCallbackURL: string;
      };
      expect(body.errorCallbackURL).toBe(`${WEB}/#/auth`);
    });

    it('is not fooled by an origin that merely starts with a trusted one', async () => {
      const { controller, auth } = makeDeps({});

      await controller.start(
        undefined,
        'https://localhost.evil.test',
        makeRes() as never,
      );

      const body = auth.api.signInSocial.mock.calls[0][0].body as {
        errorCallbackURL: string;
      };
      expect(body.errorCallbackURL).toBe(`${WEB}/#/auth`);
    });

    it('sends the visitor back into the app when Google is unconfigured', async () => {
      // Better Auth resolves rather than throws on some misconfigurations; a
      // blank redirect would hang the browser on an empty page.
      const { controller } = makeDeps({
        api: {
          signInSocial: jest
            .fn()
            .mockResolvedValue({ headers: new Headers(), response: {} }),
        },
      });
      const res = makeRes();

      await controller.start(undefined, undefined, res as never);

      expect(res.redirected).toEqual([
        `${WEB}/#/auth?error=google_unavailable`,
      ]);
    });

    it('sends the visitor back into the app when the call throws', async () => {
      const { controller } = makeDeps({
        api: { signInSocial: jest.fn().mockRejectedValue(new Error('boom')) },
      });
      const res = makeRes();

      await controller.start(undefined, undefined, res as never);

      // Property 3: never this API's own error page.
      expect(res.redirected[0].startsWith(WEB)).toBe(true);
    });
  });

  describe('finish', () => {
    it('hands the token back inside the fragment', async () => {
      const { controller } = makeDeps({});
      const res = makeRes();

      await controller.finish(
        '/history',
        undefined,
        { headers: {} } as never,
        res as never,
      );

      expect(res.redirected).toEqual([
        `${WEB}/#/auth/callback?ott=ott-1&next=%2Fhistory`,
      ]);
    });

    it('hands it back to the native shell that started the flow', async () => {
      const { controller } = makeDeps({});
      const res = makeRes();

      await controller.finish(
        undefined,
        'https://localhost',
        { headers: {} } as never,
        res as never,
      );

      expect(res.redirected).toEqual([
        'https://localhost/#/auth/callback?ott=ott-1',
      ]);
    });

    it('returns to the form with a code when the callback signed nobody in', async () => {
      const { controller } = makeDeps({
        api: {
          generateOneTimeToken: jest
            .fn()
            .mockRejectedValue(new Error('no session')),
        },
      });
      const res = makeRes();

      await controller.finish(
        undefined,
        undefined,
        { headers: {} } as never,
        res as never,
      );

      expect(res.redirected).toEqual([`${WEB}/#/auth?error=session_not_found`]);
    });

    it('revokes older sessions and warns when Google first lands on a password account', async () => {
      const { controller, deleteMany, notify } = makeDeps({
        accounts: [
          { providerId: 'credential', createdAt: new Date('2026-01-01') },
          { providerId: 'google', createdAt: new Date() },
        ],
      });

      await controller.finish(
        undefined,
        undefined,
        { headers: {} } as never,
        makeRes() as never,
      );

      expect(deleteMany).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0].message).toContain(
        'signed out everywhere else',
      );
    });

    it('leaves a returning Google user alone', async () => {
      // Signing in on a laptop must not sign the parent out on their phone.
      const { controller, deleteMany, notify } = makeDeps({
        accounts: [
          { providerId: 'credential', createdAt: new Date('2026-01-01') },
          { providerId: 'google', createdAt: new Date('2026-02-01') },
        ],
      });

      await controller.finish(
        undefined,
        undefined,
        { headers: {} } as never,
        makeRes() as never,
      );

      expect(deleteMany).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('leaves a Google-only account alone — there is no password to protect', async () => {
      const { controller, deleteMany, notify } = makeDeps({
        accounts: [{ providerId: 'google', createdAt: new Date() }],
      });

      await controller.finish(
        undefined,
        undefined,
        { headers: {} } as never,
        makeRes() as never,
      );

      expect(deleteMany).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('still completes the sign-in when the warning cannot be delivered', async () => {
      // A parent who signed in successfully must not be told they did not.
      // The notification is a side effect of a fact that is already true.
      const { controller, notify } = makeDeps({
        accounts: [
          { providerId: 'credential', createdAt: new Date('2026-01-01') },
          { providerId: 'google', createdAt: new Date() },
        ],
      });
      notify.mockRejectedValue(new Error('notifications are down'));
      const res = makeRes();

      await controller.finish(
        undefined,
        undefined,
        { headers: {} } as never,
        res as never,
      );

      expect(notify).toHaveBeenCalled();
      expect(res.redirected[0]).toContain('/#/auth/callback?ott=ott-1');
    });
  });

  describe('link/start', () => {
    it('trades the ticket for a session, then forwards the link redirect', async () => {
      const { controller, auth } = makeDeps({});
      const res = makeRes();

      await controller.linkStart('ticket-1', undefined, res as never);

      expect(auth.api.verifyOneTimeToken).toHaveBeenCalledWith({
        body: { token: 'ticket-1' },
      });
      // The recovered session is replayed as a bearer credential, which is what
      // /link-social reads — a top-level navigation could not have sent one.
      const headers = auth.api.linkSocialAccount.mock.calls[0][0]
        .headers as Headers;
      expect(headers.get('authorization')).toBe('Bearer sess-1');
      expect(res.appended).toEqual(['state=def; Path=/']);
      expect(res.redirected).toEqual(['https://accounts.google.com/link']);
    });

    it('returns to the profile screen when the ticket is missing or spent', async () => {
      const { controller } = makeDeps({
        api: {
          verifyOneTimeToken: jest.fn().mockRejectedValue(new Error('spent')),
        },
      });

      const noTicket = makeRes();
      await controller.linkStart(undefined, undefined, noTicket as never);
      expect(noTicket.redirected).toEqual([
        `${WEB}/#/profile?error=unable_to_link_account`,
      ]);

      const spent = makeRes();
      await controller.linkStart('ticket-1', undefined, spent as never);
      expect(spent.redirected).toEqual([
        `${WEB}/#/profile?error=unable_to_link_account`,
      ]);
    });
  });
});
