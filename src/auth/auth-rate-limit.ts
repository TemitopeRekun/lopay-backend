/**
 * Rate-limit policy for the authentication surface.
 *
 * ## Two layers, two jobs
 *
 * The express limiter in `app.module.ts` is a coarse **flood** guard over the whole
 * `/api/auth` handler. Better Auth's own limiter, configured here, is the
 * **credential** guard: per-path budgets that make password guessing and account
 * enumeration expensive without touching ordinary traffic.
 *
 * Splitting them this way fixes a specific collision. The single 20-per-minute
 * express bucket had to cover both jobs, so it was simultaneously too tight for
 * normal use — the SPA calls `/get-session` on every page load, so ~20 page views a
 * minute across all users exhausted it — and far too loose for credentials, where
 * 20 guesses a minute is a productive attack. Neither number can be right for both,
 * so there are now two numbers.
 *
 * ## Why this is enabled explicitly
 *
 * Better Auth defaults `rateLimit.enabled` to `isProduction`
 * (`context/create-context.mjs`), and the Render deploy runs `NODE_ENV=development`
 * on purpose — the Joi schema demands a live Paystack key and a 64-hex
 * `ENCRYPTION_KEY` the moment `NODE_ENV=production`. So on the live host this
 * limiter was silently OFF, leaving the broken express bucket as the only control.
 * `enabled: true` is unconditional here: there is no deployment of this service, dev
 * included, where "no limit on password attempts" is the behaviour we want, and a
 * conditional is how the gap appeared in the first place.
 *
 * Storage is Better Auth's default in-memory store. Correct for the single instance
 * this service runs (`numInstances: 1`); if it is ever scaled out, pass a
 * `secondaryStorage` backed by the Redis this app already optionally connects to,
 * or the budgets multiply by the instance count.
 */

/** One rule: `max` requests per `window` seconds. Better Auth counts per client IP. */
export interface AuthRateLimitRule {
  window: number;
  max: number;
}

/**
 * Paths are matched relative to `basePath` (`/api/auth`), so `/sign-in/email` here
 * is `/api/auth/sign-in/email` on the wire.
 *
 * The budgets are deliberately asymmetric — each reflects what a *legitimate* user
 * does on that route, since anything above that is either a bug or an attack:
 *
 * - `/sign-in/email` — 10/min. A person mistyping a password tries three or four
 *   times, not ten. Tight enough that an online dictionary attack against one
 *   account is hopeless; loose enough that a genuinely forgetful parent is not
 *   locked out mid-session. This is the route the whole policy exists for: with no
 *   password reset shipped yet (deferred), a lockout has no self-service way out.
 * - `/sign-up/email` — 5/min. Sign-up is a once-ever action, and it is also the
 *   cheapest way to mine the response for "is this email/phone already registered?"
 *   The guard in `signup-guard.ts` answers that question by design, so the rate is
 *   what keeps the answer from being harvested in bulk.
 * - `/sign-in/social`, `/link-social` — 10/min. Each one mints OAuth state and
 *   redirects to Google; a human clicks it once or twice.
 * - `/get-session` — 120/min. NOT a credential route: the SPA calls it on every
 *   page load and after every Google redirect, so it needs a ceiling that only a
 *   runaway client could hit. Left generous on purpose — an attacker gains nothing
 *   by replaying a session token they already hold.
 */
export const AUTH_RATE_LIMIT_RULES: Readonly<
  Record<string, AuthRateLimitRule>
> = Object.freeze({
  '/sign-in/email': { window: 60, max: 10 },
  '/sign-up/email': { window: 60, max: 5 },
  '/sign-in/social': { window: 60, max: 10 },
  '/link-social': { window: 60, max: 10 },
  '/get-session': { window: 60, max: 120 },
});

/**
 * Default budget for every auth path without a rule of its own (`/sign-out`,
 * `/update-user`, `/list-accounts`, …). Generous, because these all require a valid
 * session already — the flood guard is the relevant control there, not this one.
 */
export const AUTH_RATE_LIMIT_DEFAULT: AuthRateLimitRule = Object.freeze({
  window: 60,
  max: 100,
});

/**
 * Ceiling for the coarse express flood guard, per client IP per minute.
 *
 * 120 rather than the old 20. The old number was chosen when the bucket was
 * effectively global; per-IP it has to accommodate the burst a single household or
 * a carrier-NAT'd mobile network produces — a page load costs one `/get-session`,
 * and Nigerian mobile carriers put many subscribers behind one address. Credential
 * abuse is handled by the far tighter per-path rules above, so this layer only has
 * to stop a flood.
 */
export const AUTH_FLOOD_LIMIT_PER_MINUTE = 120;

/** Shape Better Auth expects for `rateLimit`. */
export interface AuthRateLimitOptions {
  enabled: true;
  window: number;
  max: number;
  customRules: Record<string, AuthRateLimitRule>;
}

/**
 * Budgets to use when the rate-limit key does NOT distinguish callers — i.e. the
 * deployment is TLS-fronted but nobody has declared which header carries the client
 * IP, so every caller shares one bucket.
 *
 * Every credential path is widened to the flood ceiling. This is not security being
 * switched off; it is refusing to build a denial-of-service primitive. Ten sign-ins
 * per minute is a brute-force control when the bucket belongs to one caller, and an
 * outage when it belongs to everyone — an attacker would spend ten requests a minute
 * to bar every parent from signing in, which is a worse failure than the guessing it
 * prevents. Better Auth's own built-in special rule for `/sign-in*` and `/sign-up*`
 * (3 per 10s) has the same problem, and is overridden here for the same reason.
 *
 * `app.module.ts` logs a startup warning in this state naming CLIENT_IP_HEADER, so
 * it is loud rather than silent.
 */
export const AUTH_RATE_LIMIT_SHARED_KEY_RULES: Readonly<
  Record<string, AuthRateLimitRule>
> = Object.freeze(
  Object.fromEntries(
    Object.keys(AUTH_RATE_LIMIT_RULES).map((path) => [
      path,
      { window: 60, max: AUTH_FLOOD_LIMIT_PER_MINUTE },
    ]),
  ),
);

/**
 * The `rateLimit` block passed to `betterAuth()`.
 *
 * @param trustedPerClientIp from `SecurityPosture`. When false the credential
 *   budgets widen to the flood ceiling — see `AUTH_RATE_LIMIT_SHARED_KEY_RULES`.
 */
export function buildAuthRateLimit(
  trustedPerClientIp: boolean,
): AuthRateLimitOptions {
  return {
    enabled: true,
    window: AUTH_RATE_LIMIT_DEFAULT.window,
    max: trustedPerClientIp
      ? AUTH_RATE_LIMIT_DEFAULT.max
      : AUTH_FLOOD_LIMIT_PER_MINUTE,
    customRules: {
      ...(trustedPerClientIp
        ? AUTH_RATE_LIMIT_RULES
        : AUTH_RATE_LIMIT_SHARED_KEY_RULES),
    },
  };
}
