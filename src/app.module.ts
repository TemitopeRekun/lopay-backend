import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { SchedulerModule } from './scheduler/scheduler.module';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import rateLimit from 'express-rate-limit';
import { createAuth } from './auth/auth.config';
import { PrismaService } from './prisma/prisma.service';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import { UsersModule } from './users/users.module';
import { ParentsModule } from './parents/parents.module';
import { SchoolsModule } from './schools/schools.module';
import { StudentsModule } from './students/students.module';
import { PaymentsModule } from './payments/payments.module';
import { DocumentsModule } from './documents/documents.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CommonModule } from './common/common.module';
import { PrismaModule } from './prisma/prisma.module';
import { EnrollmentModule } from './enrollment/enrollment.module';
import { AdminModule } from './admin/admin.module';
import { APP_GUARD } from '@nestjs/core';
import { BetterAuthGuard } from './auth/better-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { HealthModule } from './health/health.module';
import { FirebaseModule } from './firebase/firebase.module';
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
        // Firebase Admin SDK
        FIREBASE_PROJECT_ID: Joi.string().required(),
        FIREBASE_CLIENT_EMAIL: Joi.string().email().required(),
        FIREBASE_PRIVATE_KEY: Joi.string().required(),
        FIREBASE_STORAGE_BUCKET: Joi.string().required(),
        FIREBASE_SIGNED_URL_TTL_SECONDS: Joi.number()
          .integer()
          .min(60)
          .max(86400)
          .optional(),
        FIREBASE_MAX_UPLOAD_BYTES: Joi.number()
          .integer()
          .min(1024)
          .optional(),
        ADMIN_EMAIL: Joi.string().email().optional(),
        ADMIN_PASSWORD: Joi.string().min(8).optional(),
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
          then: Joi.string().pattern(/^sk_live_/).required(),
          otherwise: Joi.string().pattern(/^sk_(test|live)_/).required(),
        }),
        PAYSTACK_WEBHOOK_ALLOWED_IPS: Joi.string().allow('').optional(),
        PAYSTACK_CALLBACK_URL: Joi.string().uri().optional(),
        // Optional observability + multi-instance realtime (inert when unset).
        SENTRY_DSN: Joi.string().uri().optional(),
        SENTRY_TRACES_SAMPLE_RATE: Joi.number().min(0).max(1).optional(),
        REDIS_URL: Joi.string().optional(),
      }),
      validationOptions: {
        abortEarly: true,
      },
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 500,
      },
    ]),
    BetterAuthModule.forRootAsync({
      isGlobal: true,
      disableGlobalAuthGuard: true,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => {
        const limiter = rateLimit({
          windowMs: 60_000,
          limit: 20,
          standardHeaders: true,
          legacyHeaders: false,
        });
        return {
          auth: createAuth(prisma),
          bodyParser: { rawBody: true },
          middleware: (req, res, next) => {
            limiter(req, res, next);
          },
        };
      },
    }),
    FirebaseModule,
    UsersModule,
    ParentsModule,
    SchoolsModule,
    StudentsModule,
    PaymentsModule,
    DocumentsModule,
    NotificationsModule,
    DeviceTokensModule,
    CommonModule,
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
    consumer
      .apply(RequestIdMiddleware, RequestLoggerMiddleware)
      .forRoutes('*');
  }
}
