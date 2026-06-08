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
        BETTER_AUTH_SECRET: Joi.string().min(32).required(),
        BETTER_AUTH_URL: Joi.string().uri().required(),
        GOOGLE_WEB_CLIENT_ID: Joi.string().optional(),
        GOOGLE_WEB_CLIENT_SECRET: Joi.string().optional(),
        GOOGLE_ANDROID_CLIENT_ID: Joi.string().optional(),
        SUPABASE_URL: Joi.string().uri().required(),
        SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),
        SUPABASE_STORAGE_BUCKET: Joi.string().required(),
        SUPABASE_SIGNED_URL_TTL_SECONDS: Joi.number()
          .integer()
          .min(60)
          .max(86400)
          .optional(),
        ADMIN_EMAIL: Joi.string().email().optional(),
        ADMIN_PASSWORD: Joi.string().min(8).optional(),
        CORS_ORIGINS: Joi.string().allow('').optional(),
        // Paystack split payments (first-payment collection + settlement)
        PAYSTACK_SECRET_KEY: Joi.string().required(),
        PAYSTACK_WEBHOOK_ALLOWED_IPS: Joi.string().allow('').optional(),
        PAYSTACK_CALLBACK_URL: Joi.string().uri().optional(),
      }),
      validationOptions: {
        abortEarly: true,
      },
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 500, // More generous global limit for dashboard/general traffic
      },
    ]),
    // Better Auth: auto-mounts the handler at /api/auth/* (outside the api/v1
    // prefix), manages body parsing (rawBody for the Paystack webhook), and
    // exposes AuthService globally. We disable its global guard and use our own
    // BetterAuthGuard so the existing @Public()/@Roles()/@CurrentUser() stay intact.
    BetterAuthModule.forRootAsync({
      isGlobal: true,
      disableGlobalAuthGuard: true,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => {
        // /api/auth routes bypass Nest's ThrottlerGuard; rate-limit them here.
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
    UsersModule,
    ParentsModule,
    SchoolsModule,
    StudentsModule,
    PaymentsModule,
    DocumentsModule,
    NotificationsModule,
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
