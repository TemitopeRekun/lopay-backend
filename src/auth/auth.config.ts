import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer, customSession } from 'better-auth/plugins';
import type { PrismaClient } from '../generated/prisma/client';

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
  if (process.env.BETTER_AUTH_URL) trustedOrigins.push(process.env.BETTER_AUTH_URL);

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
      },
    },

    databaseHooks: {
      user: {
        create: {
          before: async (user: any) => {
            // Mirror Better Auth `name` onto the domain `fullName` column.
            return { data: { ...user, fullName: user.fullName ?? user.name } };
          },
          // NOTE: the domain `Parent` row is created lazily on first enrollment
          // (EnrollmentService.resolveEnrollmentTarget), NOT here — every sign-up
          // defaults to role PARENT at creation, so a hook here would also create
          // spurious Parent rows for school owners/admins created via signUpEmail.
        },
      },
    },

    plugins: [
      bearer(),
      customSession(async ({ user, session }) => {
        let schoolId: string | null = null;
        if ((user as any).role === 'SCHOOL_OWNER') {
          const school = await prisma.school.findUnique({
            where: { ownerId: user.id },
            select: { id: true },
          });
          schoolId = school?.id ?? null;
        }
        return {
          user: { ...user, role: (user as any).role, schoolId },
          session,
        };
      }),
    ],
  });
}

export type AppAuth = ReturnType<typeof createAuth>;
