import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer, customSession } from 'better-auth/plugins';
import type { PrismaClient } from '../generated/prisma/client';
import {
  guardUserCreate,
  guardUserUpdate,
  type UserCreateData,
} from './signup-guard';

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
  const trustedOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  // Capacitor webview origins (native shell) + local web dev (Vite) so sign-in is
  // accepted. Better Auth rejects requests whose Origin isn't trusted (CSRF guard).
  trustedOrigins.push(
    'capacitor://localhost',
    'http://localhost',
    'http://localhost:5173',
    'http://localhost:5174',
  );
  if (process.env.BETTER_AUTH_URL)
    trustedOrigins.push(process.env.BETTER_AUTH_URL);

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

    // Cross-origin cookie session support for the web SPA (M2 dual-path "cookie"
    // mode). The SPA is served from a different origin than the API, so the
    // session cookie must be SameSite=None; Secure to be sent on API/socket
    // requests; httpOnly keeps it out of JS (XSS-safe). Only applied in
    // production — local dev is same-site over http where the Lax default works
    // and a Secure cookie would be dropped. The bearer path ignores cookies, so
    // this is inert for native/bearer clients.
    advanced:
      process.env.NODE_ENV === 'production'
        ? {
            defaultCookieAttributes: {
              sameSite: 'none',
              secure: true,
              httpOnly: true,
            },
          }
        : undefined,

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
        phoneHash: {
          type: 'string',
          required: false,
          input: false,
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
