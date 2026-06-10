import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { initSentry } from './common/observability/sentry';
import { RedisIoAdapter } from './events/redis-io.adapter';

async function bootstrap() {
  // Error tracking (no-op unless SENTRY_DSN is set). Init before app handles traffic.
  initSentry();
  // bodyParser:false — the Better Auth NestJS module owns body parsing (it must
  // hand the raw request to the auth handler). It re-adds JSON/urlencoded for all
  // other routes and, with bodyParser.rawBody:true, attaches req.rawBody (used by
  // the Paystack webhook for HMAC verification).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Security headers
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      // This service returns JSON only (the SPA is a separate origin). A strict
      // CSP is the strongest defense against any reflected-content XSS — and
      // replaces the deprecated X-XSS-Protection header. Swagger (dev only) needs
      // inline assets, so the CSP is applied in production only.
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
    }
    next();
  });

  // Note: the global prefix excludes the Better Auth handler (the module adds
  // /api/auth to the prefix exclude list automatically).
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Enable CORS
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const corsOriginsRaw = process.env.CORS_ORIGINS ?? '';
  const corsOrigins = corsOriginsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin:
      corsOrigins.length > 0
        ? corsOrigins
        : nodeEnv === 'development'
          ? true
          : false,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: corsOrigins.length > 0,
  });

  // Swagger Configuration
  if (nodeEnv !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('LoPay API')
      .setDescription('The LoPay API documentation for frontend integration')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, document);
  }

  // Multi-instance realtime: attach the Redis Socket.IO adapter when REDIS_URL is
  // configured (no-op / in-memory otherwise — correct for a single instance).
  const redisAdapter = new RedisIoAdapter(app);
  if (await redisAdapter.connectToRedis()) {
    app.useWebSocketAdapter(redisAdapter);
  }

  // Drain in-flight work and close the DB pool on SIGTERM (Render deploys/restarts)
  // instead of tearing payment transactions mid-flight. PrismaService.onModuleDestroy
  // ($disconnect) only fires when shutdown hooks are enabled.
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`Application is running on: ${await app.getUrl()}`);
  logger.log(`API available at: ${await app.getUrl()}/api/v1`);
}
bootstrap();
