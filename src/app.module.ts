import { Module, MiddlewareConsumer, NestModule, Logger } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ScheduleModule } from '@nestjs/schedule';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { SchedulerModule } from './scheduler/scheduler.module';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request, Response, NextFunction } from 'express';
import type Redis from 'ioredis';
import { createAuth } from './auth/auth.config';
import { AUTH_FLOOD_LIMIT_PER_MINUTE } from './auth/auth-rate-limit';
import { clientIpKey, stampClientIp } from './common/client-ip';
import { resolveSecurityPosture } from './common/security-posture';
import { PrismaService } from './prisma/prisma.service';
import { ConfigModule } from '@nestjs/config';
import { RedisModule, REDIS_CLIENT } from './redis/redis.module';
import { CacheModule } from './cache/cache.module';
import { MetricsModule } from './common/observability/metrics.module';
import * as Joi from 'joi';
import { UsersModule } from './users/users.module';
import { SchoolsModule } from './schools/schools.module';
import { PaymentsModule } from './payments/payments.module';
import { DocumentsModule } from './documents/documents.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { EnrollmentModule } from './enrollment/enrollment.module';
import { AdminModule } from './admin/admin.module';
import { APP_GUARD } from '@nestjs/core';
import { BetterAuthGuard } from './auth/better-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { HealthModule } from './health/health.module';
import { FirebaseModule } from './firebase/firebase.module';
import { SupabaseModule } from './supabase/supabase.module';
import { DeviceTokensModule } from './device-tokens/device-tokens.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'production', 'test')
          .default('development'),
        PORT: Joi.number().default(3001),
        DATABASE_URL: Joi.string().uri().required(),
        // Per-instance pg pool ceiling (M4 scale). Optional; defaults to 10.
        DATABASE_POOL_MAX: Joi.number().integer().min(1).max(100).optional(),
        // DB TLS control. 'disable' skips TLS (same-host/private-network Postgres);
        // 'require' forces TLS even outside production (e.g. a staging/dev app
        // pointed at Supabase/Neon). Unset = TLS on in production, off otherwise.
        DATABASE_SSL: Joi.string()
          .valid('disable', 'false', 'off', 'require', 'true', 'on')
          .optional(),
        // Better Auth (replaces Firebase + the old backend JWT)
        // Reject obvious placeholders so a deploy can't boot with template values.
        BETTER_AUTH_SECRET: Joi.string()
          .min(32)
          .invalid('dev-better-auth-secret-please-change-min-32-chars')
          .pattern(/REPLACE_ME/i, { invert: true })
          .required(),
        BETTER_AUTH_URL: Joi.string().uri().required(),
        GOOGLE_WEB_CLIENT_ID: Joi.string().optional(),
        GOOGLE_WEB_CLIENT_SECRET: Joi.string().optional(),
        GOOGLE_ANDROID_CLIENT_ID: Joi.string().optional(),
        // Firebase Admin SDK — FCM push notifications only (receipts use Supabase).
        FIREBASE_PROJECT_ID: Joi.string().required(),
        FIREBASE_CLIENT_EMAIL: Joi.string().email().required(),
        FIREBASE_PRIVATE_KEY: Joi.string().required(),
        // Supabase Storage for receipt upload/download signed URLs. Optional —
        // when URL/key are unset, receipt storage is disabled and /health reports
        // storage as degraded (the service still boots).
        SUPABASE_URL: Joi.string().uri().optional(),
        SUPABASE_SERVICE_ROLE_KEY: Joi.string().optional(),
        SUPABASE_STORAGE_BUCKET: Joi.string().optional(),
        SUPABASE_SIGNED_URL_TTL_SECONDS: Joi.number()
          .integer()
          .min(60)
          .max(86400)
          .optional(),
        SUPABASE_MAX_UPLOAD_BYTES: Joi.number().integer().min(1024).optional(),
        ADMIN_EMAIL: Joi.string().email().optional(),
        ADMIN_PASSWORD: Joi.string().min(8).optional(),
        // Origin of the web client, used to build the absolute URL a WEB push
        // notification opens when tapped (`webpush.fcmOptions.link`). Optional:
        // NotificationsService falls back to the first CORS_ORIGINS entry, which
        // is the web client by definition. Set it explicitly once CORS_ORIGINS
        // lists more than one origin, or the link may point at the wrong one.
        WEB_APP_URL: Joi.string().uri().optional(),
        // Required (non-empty) in production so the API can't boot wide-open;
        // optional locally where main.ts reflects the dev origin.
        CORS_ORIGINS: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.string().required(),
          otherwise: Joi.string().allow('').optional(),
        }),
        // Paystack split payments. Must be a real sk_(test|live)_ key — reject
        // placeholders; require a LIVE key in production.
        PAYSTACK_SECRET_KEY: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.string()
            .pattern(/^sk_live_/)
            .required(),
          otherwise: Joi.string()
            .pattern(/^sk_(test|live)_/)
            .required(),
        }),
        PAYSTACK_WEBHOOK_ALLOWED_IPS: Joi.string().allow('').optional(),
        PAYSTACK_CALLBACK_URL: Joi.string().uri().optional(),
        // Optional observability + multi-instance realtime (inert when unset).
        SENTRY_DSN: Joi.string().uri().optional(),
        SENTRY_TRACES_SAMPLE_RATE: Joi.number().min(0).max(1).optional(),
        REDIS_URL: Joi.string().optional(),
        // Reverse-proxy hop count for Express `trust proxy` (e.g. 1 behind Caddy).
        // Unset -> the app trusts no proxy (direct exposure).
        TRUST_PROXY: Joi.string().optional(),
        // Serve Swagger UI (/api) and the OpenAPI document (/api-json). Defaults to
        // OFF: this is a public internet host, and NODE_ENV cannot be used to gate
        // it (the deploy runs NODE_ENV=development on purpose).
        API_DOCS_ENABLED: Joi.string().optional(),
        // Name of the request header carrying the true client IP at this
        // deployment's edge, e.g. `cf-connecting-ip` behind Cloudflare. Used to key
        // the auth rate limiters. Unset -> the socket address is used, which behind
        // a proxy means ONE shared bucket for every caller. Only name a header the
        // edge is known to overwrite; one it merely appends to is caller-spoofable.
        // Confirm a candidate by watching the `clientIp` field in the request log.
        CLIENT_IP_HEADER: Joi.string().optional(),
        // PII encryption at rest. Optional in dev (plaintext fallback), required
        // in production. Must be exactly 64 hex chars (32 bytes).
        ENCRYPTION_KEY: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.string().length(64).hex().required(),
          otherwise: Joi.string().length(64).hex().optional(),
        }),
      }),
      validationOptions: {
        abortEarly: true,
      },
    }),
    // Global request throttler. When REDIS_URL is set, counters live in the shared
    // Redis so the limit holds ACROSS instances; otherwise the default in-memory
    // store is used (correct for single-instance dev). (M4 scale)
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis | null) => ({
        throttlers: [{ ttl: 60000, limit: 500 }],
        storage: redis ? new ThrottlerStorageRedisService(redis) : undefined,
      }),
    }),
    BetterAuthModule.forRootAsync({
      isGlobal: true,
      disableGlobalAuthGuard: true,
      inject: [PrismaService, REDIS_CLIENT],
      useFactory: (prisma: PrismaService, redis: Redis | null) => {
        // Coarse flood guard over the whole /api/auth handler. Shared Redis store
        // when available so the cap is enforced across all instances (a
        // per-instance in-memory limiter would let an attacker multiply attempts by
        // the instance count).
        //
        // Two fixes here over the original 20/min:
        //
        //  - `keyGenerator`. The default keys on `req.ip`, which behind Render's
        //    edge is the SAME value for every caller on the internet — one global
        //    bucket. Verified against the live deploy: requests carrying different
        //    X-Forwarded-For values all decremented one counter. Since the SPA calls
        //    /get-session on every page load, ordinary traffic exhausted it, and an
        //    attacker could lock every user out of signing in with a trickle of
        //    requests. See common/client-ip.ts for why the header is declared rather
        //    than inferred from a `trust proxy` hop count.
        //  - The ceiling moves to 120/min, because per-IP it must absorb the burst
        //    from a household or a carrier-NAT'd mobile network. Credential abuse is
        //    now handled by Better Auth's far tighter per-path rules
        //    (auth-rate-limit.ts) instead of by this one number.
        const posture = resolveSecurityPosture(process.env);
        const clientIpHeader = posture.clientIpHeader;

        // A TLS-fronted deployment with no declared client-IP header cannot tell two
        // callers apart, so the credential budgets widen to the flood ceiling to
        // avoid handing an attacker a lockout primitive (see auth-rate-limit.ts).
        // That trade-off must be visible: silently running looser limits than the
        // code appears to promise is how the original bug survived unnoticed.
        if (!posture.trustedPerClientIp) {
          new Logger('AuthRateLimit').warn(
            'CLIENT_IP_HEADER is not set on a TLS-fronted deployment: every caller ' +
              'shares one rate-limit bucket, so per-path credential limits are ' +
              'relaxed to the flood ceiling. Set CLIENT_IP_HEADER to the header your ' +
              'edge overwrites (e.g. cf-connecting-ip) — confirm the value by ' +
              'watching the `clientIp` field in the request log.',
          );
        }
        const limiter = rateLimit({
          windowMs: 60_000,
          limit: AUTH_FLOOD_LIMIT_PER_MINUTE,
          standardHeaders: true,
          legacyHeaders: false,
          keyGenerator: (req: Request) => clientIpKey(req, clientIpHeader),
          ...(redis
            ? {
                store: new RedisStore({
                  prefix: 'auth-rl:',
                  sendCommand: (...args: string[]) =>
                    redis.call(args[0], ...args.slice(1)) as Promise<
                      string | number
                    >,
                }),
              }
            : {}),
        });
        return {
          auth: createAuth(prisma),
          bodyParser: { rawBody: true },
          middleware: (req: Request, res: Response, next: NextFunction) => {
            // Stamp the resolved client IP BEFORE anything else runs. Better Auth
            // only sees headers, so this is how its limiter and session tracking get
            // a client IP that the caller cannot forge — and it must happen upstream
            // of both the limiter below and the auth handler. Overwrites any inbound
            // value; see common/client-ip.ts.
            stampClientIp(req, clientIpHeader);
            limiter(req, res, next);
          },
        };
      },
    }),
    RedisModule,
    CacheModule,
    MetricsModule,
    FirebaseModule,
    SupabaseModule,
    UsersModule,
    SchoolsModule,
    PaymentsModule,
    DocumentsModule,
    NotificationsModule,
    DeviceTokensModule,
    PrismaModule,
    EnrollmentModule,
    AdminModule,
    HealthModule,
    SchedulerModule,
  ],

  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: BetterAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware, RequestLoggerMiddleware).forRoutes('*');
  }
}
