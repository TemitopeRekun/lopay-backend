import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { MetricsAuthGuard } from './metrics.guard';

/**
 * `/metrics` publishes payment volume, confirmation latency and stalled-
 * confirmation counts. It was reachable unauthenticated on the live deploy, so
 * these tests pin the access policy itself — including the fail-closed default,
 * which is the part a future refactor is most likely to soften.
 */
describe('MetricsAuthGuard', () => {
  const guard = new MetricsAuthGuard();

  const contextWith = (headers: Record<string, string> = {}) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    }) as unknown as ExecutionContext;

  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.METRICS_TOKEN;
    delete process.env.NODE_ENV;
    delete process.env.BETTER_AUTH_URL;
  });

  /**
   * "Internet-facing" is derived from BETTER_AUTH_URL being https, never from
   * NODE_ENV — this deploy runs NODE_ENV=development on a public host.
   */
  const givenInternetFacing = () => {
    process.env.BETTER_AUTH_URL = 'https://lopay-backend.onrender.com';
  };
  const givenLocal = () => {
    process.env.BETTER_AUTH_URL = 'http://localhost:3001';
  };

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('no METRICS_TOKEN configured', () => {
    it('allows the scrape on a local (non-TLS) deployment', () => {
      givenLocal();
      expect(guard.canActivate(contextWith())).toBe(true);
    });

    it('allows the scrape when BETTER_AUTH_URL is unset', () => {
      expect(guard.canActivate(contextWith())).toBe(true);
    });

    it('fails CLOSED on an internet-facing deployment', () => {
      givenInternetFacing();
      expect(() => guard.canActivate(contextWith())).toThrow(NotFoundException);
    });

    it('closes even though NODE_ENV is "development" on that host', () => {
      // The regression this pins: gating on NODE_ENV left /metrics open on the
      // live Render host, which sets NODE_ENV=development deliberately.
      givenInternetFacing();
      process.env.NODE_ENV = 'development';
      expect(() => guard.canActivate(contextWith())).toThrow(NotFoundException);
    });

    it('does not close a local deploy just because NODE_ENV says production', () => {
      givenLocal();
      process.env.NODE_ENV = 'production';
      expect(guard.canActivate(contextWith())).toBe(true);
    });

    it('treats a whitespace-only token as unset', () => {
      givenInternetFacing();
      process.env.METRICS_TOKEN = '   ';
      expect(() => guard.canActivate(contextWith())).toThrow(NotFoundException);
    });
  });

  describe('METRICS_TOKEN configured', () => {
    beforeEach(() => {
      givenInternetFacing();
      process.env.METRICS_TOKEN = 'scrape-me';
    });

    it('accepts the token as an Authorization bearer', () => {
      expect(
        guard.canActivate(contextWith({ authorization: 'Bearer scrape-me' })),
      ).toBe(true);
    });

    it('accepts a lowercase scheme and extra whitespace', () => {
      expect(
        guard.canActivate(contextWith({ authorization: 'bearer   scrape-me' })),
      ).toBe(true);
    });

    it('accepts the X-Metrics-Token header', () => {
      expect(
        guard.canActivate(contextWith({ 'x-metrics-token': 'scrape-me' })),
      ).toBe(true);
    });

    it('rejects a wrong token', () => {
      expect(() =>
        guard.canActivate(contextWith({ authorization: 'Bearer nope' })),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a token of a different length (no timingSafeEqual throw)', () => {
      // Digesting both sides first is what keeps this from throwing on unequal
      // lengths — a regression here would surface as a 500, not a 401.
      expect(() =>
        guard.canActivate(contextWith({ authorization: 'Bearer x' })),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a missing credential', () => {
      expect(() => guard.canActivate(contextWith())).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a non-bearer Authorization scheme', () => {
      expect(() =>
        guard.canActivate(contextWith({ authorization: 'Basic scrape-me' })),
      ).toThrow(UnauthorizedException);
    });

    it('still requires the token on a local deployment', () => {
      givenLocal();
      expect(() => guard.canActivate(contextWith())).toThrow(
        UnauthorizedException,
      );
    });
  });
});
