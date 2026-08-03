import {
  AUTH_FLOOD_LIMIT_PER_MINUTE,
  AUTH_RATE_LIMIT_DEFAULT,
  AUTH_RATE_LIMIT_RULES,
  AUTH_RATE_LIMIT_SHARED_KEY_RULES,
  buildAuthRateLimit,
} from './auth-rate-limit';

describe('buildAuthRateLimit', () => {
  // Better Auth defaults `rateLimit.enabled` to `isProduction`, and this service
  // runs NODE_ENV=development on its live host by design — so inheriting the default
  // meant no per-path limit at all in production. It is unconditional now, and this
  // test is what keeps a well-meaning "only in production" refactor from
  // reintroducing the gap.
  it('is enabled unconditionally', () => {
    expect(buildAuthRateLimit(true).enabled).toBe(true);
  });

  it('carries the default budget for unlisted paths', () => {
    const config = buildAuthRateLimit(true);
    expect(config.window).toBe(AUTH_RATE_LIMIT_DEFAULT.window);
    expect(config.max).toBe(AUTH_RATE_LIMIT_DEFAULT.max);
  });

  it('passes the per-path rules through', () => {
    expect(buildAuthRateLimit(true).customRules).toEqual(AUTH_RATE_LIMIT_RULES);
  });

  // Found in self-review. Better Auth's limiter keys on an IP it reads from headers,
  // so when nothing trustworthy identifies the caller, every caller lands in one
  // bucket — and a 10-per-minute cap on /sign-in/email stops being a brute-force
  // control and becomes a lockout primitive: ten requests a minute and nobody can
  // sign in. A shared key therefore gets the flood ceiling, not the tight budget.
  describe('with a rate-limit key that cannot distinguish callers', () => {
    it('widens every credential path to the flood ceiling', () => {
      const config = buildAuthRateLimit(false);
      expect(config.customRules['/sign-in/email'].max).toBe(
        AUTH_FLOOD_LIMIT_PER_MINUTE,
      );
      expect(config.customRules['/sign-up/email'].max).toBe(
        AUTH_FLOOD_LIMIT_PER_MINUTE,
      );
    });

    it('stays enabled — a flood guard is still a guard', () => {
      expect(buildAuthRateLimit(false).enabled).toBe(true);
    });

    it('widens the default budget too', () => {
      expect(buildAuthRateLimit(false).max).toBe(AUTH_FLOOD_LIMIT_PER_MINUTE);
    });

    // Better Auth ships its own special rule for /sign-in* and /sign-up* (3 per
    // 10s). On a shared key that has exactly the same lockout problem, so every
    // credential path must be present in customRules to override it — a path missing
    // here would silently inherit the tighter built-in.
    it('covers every path the built-in special rule would otherwise catch', () => {
      const shared = Object.keys(AUTH_RATE_LIMIT_SHARED_KEY_RULES);
      for (const path of Object.keys(AUTH_RATE_LIMIT_RULES)) {
        expect(shared).toContain(path);
      }
      for (const path of shared) {
        if (path.startsWith('/sign-in') || path.startsWith('/sign-up')) {
          expect(AUTH_RATE_LIMIT_SHARED_KEY_RULES[path].max).toBe(
            AUTH_FLOOD_LIMIT_PER_MINUTE,
          );
        }
      }
    });

    it('is never tighter than the trusted-key policy', () => {
      const tight = buildAuthRateLimit(true);
      const shared = buildAuthRateLimit(false);
      for (const path of Object.keys(shared.customRules)) {
        expect(shared.customRules[path].max).toBeGreaterThanOrEqual(
          tight.customRules[path].max,
        );
      }
    });
  });

  it('returns a copy, so a caller cannot mutate the shared policy', () => {
    const config = buildAuthRateLimit(true);
    config.customRules['/sign-in/email'] = { window: 1, max: 10_000 };
    expect(AUTH_RATE_LIMIT_RULES['/sign-in/email']).toEqual({
      window: 60,
      max: 10,
    });
  });
});

describe('AUTH_RATE_LIMIT_RULES', () => {
  it('covers every route an unauthenticated caller can reach', () => {
    expect(Object.keys(AUTH_RATE_LIMIT_RULES)).toEqual(
      expect.arrayContaining([
        '/sign-in/email',
        '/sign-up/email',
        '/sign-in/social',
        '/link-social',
      ]),
    );
  });

  // The credential routes are the reason the policy exists. With password reset
  // deferred, a lockout has no self-service escape, so these have to be tight
  // enough to defeat online guessing yet loose enough for a forgetful parent.
  it('keeps password guessing to single digits per minute', () => {
    const rule = AUTH_RATE_LIMIT_RULES['/sign-in/email'];
    expect(rule.window).toBe(60);
    expect(rule.max).toBeLessThanOrEqual(10);
    expect(rule.max).toBeGreaterThanOrEqual(3);
  });

  // Sign-up is the cheapest oracle for "is this email or phone already registered?"
  // — signup-guard.ts answers that by design, so the rate is what stops the answer
  // being harvested in bulk.
  it('keeps sign-up tighter than sign-in', () => {
    expect(AUTH_RATE_LIMIT_RULES['/sign-up/email'].max).toBeLessThan(
      AUTH_RATE_LIMIT_RULES['/sign-in/email'].max,
    );
  });

  // /get-session runs on every page load and after every Google redirect. Holding it
  // to a credential-route budget is precisely what broke ordinary browsing before.
  it('gives /get-session room for real browsing', () => {
    const rule = AUTH_RATE_LIMIT_RULES['/get-session'];
    expect(rule.max).toBeGreaterThanOrEqual(60);
    expect(rule.max).toBeGreaterThan(
      AUTH_RATE_LIMIT_RULES['/sign-in/email'].max,
    );
  });

  it('uses a one-minute window for every rule', () => {
    for (const rule of Object.values(AUTH_RATE_LIMIT_RULES)) {
      expect(rule.window).toBe(60);
    }
  });
});

describe('AUTH_FLOOD_LIMIT_PER_MINUTE', () => {
  // The coarse guard has to absorb a household or carrier-NAT'd mobile network on
  // one address, so it sits well above the credential budgets rather than competing
  // with them.
  it('is loose enough for a shared address', () => {
    expect(AUTH_FLOOD_LIMIT_PER_MINUTE).toBeGreaterThanOrEqual(
      AUTH_RATE_LIMIT_RULES['/get-session'].max,
    );
  });

  it('still bounds a flood', () => {
    expect(AUTH_FLOOD_LIMIT_PER_MINUTE).toBeLessThanOrEqual(600);
  });
});
