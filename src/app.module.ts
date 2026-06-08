import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { SchedulerModule } from './scheduler/scheduler.module';
import { AuthModule } from './auth/auth.module';
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
import { JwtAuthGuard } from './auth/jwt-auth.guard';
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
        JWT_SECRET: Joi.string().min(32).required(),
        FIREBASE_PROJECT_ID: Joi.string().required(),
        FIREBASE_CLIENT_EMAIL: Joi.string().email().required(),
        FIREBASE_PRIVATE_KEY: Joi.string().required(),
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
    AuthModule,
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
      useClass: JwtAuthGuard,
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
