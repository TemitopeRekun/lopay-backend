import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer, customSession, oneTimeToken } from 'better-auth/plugins';
import type { PrismaClient } from '../generated/prisma/client';
import {
  guardUserCreate,
  guardUserUpdate,
  type UserCreateData,
} from './signup-guard';
import { buildTrustedOrigins } from './trusted-origins';
import { buildAuthRateLimit } from './auth-rate-limit';
import { resolveSecurityPosture } from '../common/security-posture';
import { RESOLVED_CLIENT_IP_HEADER } from '../common/client-ip';
import { createBetterAuthLogger } from '../common/logger/better-auth-logger';

/**
 * Builds the Better Auth instance. Takes the app's PrismaClient so it shares the
 * single pg pool/driver-adapter (do NOT construct a second client).
 *
 * - email/password + Google social sign-in
 * - bearer plugin: returns a token in the `set-auth-token` header that mobile/web
 *   store and replay as `Authorization: Bearer` (matches the existing axios client)
 * - customSession: injects `role` + `schoolId` so the NestJS guard can populate
 *   `request.user = { userId, role, schoolId }` without per-request churn
 * - databaseHooks: keep `fullName` in sync with Better Auth's `name`, and create
 *   the domain `Parent` row when a PARENT signs up
 */
export function createAuth(prisma: PrismaClient) {
  // Security posture is derived from what this deployment IS (is it served over
  // TLS?) rather than from NODE_ENV — see security-posture.ts for why the old
  // NODE_ENV coupling failed open on the Render host.
  const posture = resolveSecurityPosture(process.env);
  const trustedOrigins = buildTrustedOrigins({
    corsOrigins: process.env.CORS_ORIGINS,
    betterAuthUrl: process.env.BETTER_AUTH_URL,
    httpsDeployment: posture.httpsDeployment,
  });

  return betterAuth({
    basePath: '/api/auth',
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins,

    database: prismaAdapter(prisma, { provider: 'postgresql' }),

    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 8,
    },

    // Rate limiting. Enabled unconditionally rather than inheriting Better Auth's
    // `isProduction` default, which left it OFF on the Render deploy (NODE_ENV is
    // deliberately `development` there). See auth-rate-limit.ts.
    rateLimit: buildAuthRateLimit(posture.trustedPerClientIp),

    advanced: {
      // Cross-origin cookie session support for the web SPA (M2 dual-path "cookie"
      // mode). The SPA is served from a different origin than the API, so the
      // session cookie must be SameSite=None; Secure to be sent on API/socket
      // requests; httpOnly keeps it out of JS (XSS-safe).
      //
      // Gated on the deployment being https, NOT on NODE_ENV: `SameSite=None`
      // without `Secure` is dropped by every browser, and `Secure` needs TLS. The
      // old NODE_ENV gate meant the live https deploy kept the `Lax` default and
      // cookie mode could not work cross-origin at all. Local http dev still gets
      // `Lax`, which is what works there. The bearer path ignores cookies, so this
      // is inert for native/bearer clients.
      ...(posture.crossSiteCookies
        ? {
            defaultCookieAttributes: {
              sameSite: 'none' as const,
              secure: true,
              httpOnly: true,
            },
          }
        : {}),

      // Read the caller's IP from the header this app stamps itself, and from
      // nothing else.
      //
      // NOT optional, and not `CLIENT_IP_HEADER` directly. Better Auth only sees a
      // web Request, so its `getIp` reads headers; left unset it defaults to
      // `["x-forwarded-for"]` and takes the LEFTMOST entry — the value the CALLER
      // sent, because an edge appends rather than replaces. Its limiter would then
      // key on a number the attacker picks, and a fresh `X-Forwarded-For: <random>`
      // per request buys unlimited password guesses. Pointing it at a header that
      // `stampClientIp` overwrites on every request closes that off and gives both
      // limiters one source of truth. See client-ip.ts.
      ipAddress: { ipAddressHeaders: [RESOLVED_CLIENT_IP_HEADER] },
    },

    account: {
      // Encrypt the OAuth access/refresh/id tokens at rest. Without this they sit
      // in `Account` as plaintext, so a database dump hands over live Google
      // credentials for every user who signed in with Google — the one class of
      // secret in this schema that grants access to a THIRD party's system, not
      // just ours. Better Auth's reader (`decryptOAuthToken`) sniffs the ciphertext
      // shape, so any rows written before this was enabled keep working.
      encryptOAuthTokens: true,

      // Attach Google to an account that already exists under the same email.
      //
      // ## Why both flags are needed, and why the first alone does nothing
      //
      // `handleOAuthUserInfo` refuses to link when
      //
      //     (!isTrustedProvider && !userInfo.emailVerified)
      //       || (requireLocalEmailVerified && !dbUser.user.emailVerified)
      //
      // Only the SECOND clause was ever firing here. `trustedProviders` alone
      // would have changed nothing: `requireLocalEmailVerified` defaults to true,
      // this app sends no verification mail, and every row in `User` therefore
      // has `emailVerified = false` — all 21 of them in production, checked.
      // So "Continue with Google" on an existing email/password account failed
      // 100% of the time, redirected to `errorCallbackURL`, and (until the web
      // client learned to read `?error=`) said nothing at all.
      //
      // ## The risk this accepts, and what bounds it
      //
      // Password sign-up proves nothing about the mailbox. So an attacker who
      // registers `victim@gmail.com` BEFORE the victim does, and waits, has their
      // password merged into the victim's account the moment the victim arrives
      // via Google. That vector is real and is the reason this was off.
      //
      // Two things bound it, and neither is a substitute for verifying email:
      //
      //   - it is a race the attacker has to win, against a specific person, on
      //     a platform they have to know that person is about to join;
      //   - it closes per account on first use. Google asserts `email_verified`,
      //     so the link sets `emailVerified = true` on the row (see the same
      //     function), and `requireLocalEmailVerified` stops being the thing
      //     standing between that account and a link.
      //
      // `OAuthHandoffController` narrows the window further by revoking every
      // other session on the account at link time, so an attacker already signed
      // in is cut off rather than left alongside the owner.
      //
      // The durable fix is email verification; when a mail provider exists, set
      // `requireLocalEmailVerified` back to true and this whole trade goes away.
      accountLinking: {
        enabled: true,
        trustedProviders: ['google'],
        requireLocalEmailVerified: false,
      },
    },

    // Route Better Auth's own diagnostics through the Nest logger with PII
    // scrubbing: it logs the caller's email verbatim on a failed sign-in.
    logger: createBetterAuthLogger(),

    socialProviders: {
      google: {
        clientId: [
          process.env.GOOGLE_WEB_CLIENT_ID,
          process.env.GOOGLE_ANDROID_CLIENT_ID,
        ].filter(Boolean) as string[],
        clientSecret: process.env.GOOGLE_WEB_CLIENT_SECRET ?? '',
      },
    },

    user: {
      additionalFields: {
        // Backed by the Prisma `UserRole` enum column. input:false so public
        // sign-ups CANNOT self-assign a role — everyone is PARENT by default;
        // SCHOOL_OWNER/SUPER_ADMIN are set server-side after creation (onboarding/seed).
        role: {
          type: 'string',
          required: false,
          input: false,
          defaultValue: 'PARENT',
        },
        // Captured at sign-up; mirrored onto the Parent row by the hook below.
        phoneNumber: {
          type: 'string',
          required: false,
          input: true,
        },
        // Domain display name kept in sync with Better Auth `name`.
        fullName: {
          type: 'string',
          required: false,
          input: false,
        },
        // Blind index over `phoneNumber` — the column that actually enforces one
        // account per phone number (see src/common/phone.ts). input:false because
        // it is derived server-side from the submitted number: accepting it as an
        // input would let a caller claim a hash that doesn't match their number,
        // or squat on someone else's.
        //
        // returned:false because it must not travel the other way either. The
        // sign-up, sign-in and get-session payloads were handing the hash to the
        // client, which then persisted it to localStorage — so the value whose
        // entire purpose is to make a stolen database useless without the HMAC key
        // was being published to every client, and any XSS could harvest it. It is
        // also a stable cross-account identifier for a phone number: two accounts
        // sharing a number are trivially correlated by comparing hashes. Nothing
        // client-side reads it; the server queries the column through Prisma
        // directly, which this flag does not affect.
        phoneHash: {
          type: 'string',
          required: false,
          input: false,
          returned: false,
        },
      },
    },

    databaseHooks: {
      user: {
        create: {
          // Sanitize, validate, and enforce phone uniqueness for EVERY creation
          // path (email sign-up, Google sign-in, admin owner provisioning). See
          // signup-guard.ts for why this is the right seam and why an APIError
          // thrown here reaches the client with its code intact.
          before: (user: UserCreateData) => {
            return guardUserCreate(prisma, user).then((data) => ({ data }));
          },
          // NOTE: the domain `Parent` row is created lazily on first enrollment
          // (EnrollmentService.resolveEnrollmentTarget), NOT here — every sign-up
          // defaults to role PARENT at creation, so a hook here would also create
          // spurious Parent rows for school owners/admins created via signUpEmail.
        },
        update: {
          // Keep phoneHash in step with phoneNumber on Better Auth's own update
          // route, so a number changed there can't leave a stale reservation
          // behind. The user-facing profile path is PATCH /users/me.
          before: (user: UserCreateData) => {
            return Promise.resolve({ data: guardUserUpdate(user) });
          },
        },
      },
    },

    plugins: [
      bearer(),

      // How a browser-wide OAuth redirect hands a session to a SPA on another
      // origin, without either side depending on a cross-site cookie.
      //
      // The web client lives on `lopay.netlify.app` and this API on
      // `lopay-backend.onrender.com`. They are different SITES, so every cookie
      // this server sets is third-party to the SPA — and the OAuth handshake
      // needs a cookie to travel in the one direction that guarantees a miss:
      // the state cookie is WRITTEN during a cross-origin fetch (partition: the
      // SPA's site) and READ during a top-level navigation where this API is
      // first-party (partition: this API's site). Safari blocks the write
      // outright, Firefox partitions it into a jar the callback never consults,
      // and `Partitioned`/CHIPS makes it worse rather than better for exactly
      // that reason. `OAuthHandoffController` fixes the write side by starting
      // the flow as a top-level navigation; this plugin fixes the read side.
      //
      // At the end of a successful callback the handoff route mints one of these
      // and puts it in the FRAGMENT of the redirect back to the SPA — never the
      // query string, so it reaches no access log and no `Referer`. The SPA
      // exchanges it at `POST /api/auth/one-time-token/verify`, an ordinary CORS
      // request carrying no cookies, and the `bearer` plugin above turns that
      // response's session cookie into the `set-auth-token` header the client
      // already persists. Nothing in the path needs a cookie to cross a site
      // boundary, which is what makes it work identically in Safari, Firefox,
      // a Chrome incognito window and the Capacitor shell.
      //
      // `storeToken: 'hashed'` for the same reason `EnrollmentInvite.tokenHash`
      // is hashed: this is a bearer credential that exchanges for a full
      // session, and a database dump must not contain a replayable copy. Three
      // minutes is a redirect hop, not a session — it is consumed within a
      // second of being minted, and the row is deleted on use.
      oneTimeToken({
        expiresIn: 3,
        storeToken: 'hashed',
      }),

      customSession(async ({ user, session }) => {
        // Better Auth's base user type doesn't include our `role` column; read it
        // off a narrowed view rather than `any`.
        const role = (user as { role?: string }).role;
        let schoolId: string | null = null;
        if (role === 'SCHOOL_OWNER') {
          const school = await prisma.school.findUnique({
            where: { ownerId: user.id },
            select: { id: true },
          });
          schoolId = school?.id ?? null;
        }
        return {
          user: { ...user, role, schoolId },
          session,
        };
      }),
    ],
  });
}

export type AppAuth = ReturnType<typeof createAuth>;
