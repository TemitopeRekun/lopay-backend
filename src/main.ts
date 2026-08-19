import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { initSentry } from './common/observability/sentry';
import { RedisIoAdapter } from './events/redis-io.adapter';
import { initEncryptionKey } from './common/encryption';
import { JsonLogger } from './common/logger/json.logger';
import { resolveSecurityPosture } from './common/security-posture';
import { resolveCorsAllowlist } from './common/cors-origins';

async function bootstrap() {
  initSentry();
  initEncryptionKey(process.env.ENCRYPTION_KEY);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.useLogger(new JsonLogger());

  // Behind a reverse proxy (e.g. Caddy on the Oracle VM), trust the X-Forwarded-*
  // headers so the rate limiters and logs see the real client IP instead of the
  // proxy's. TRUST_PROXY is the hop count (1 = one proxy). Unset -> off, so a
  // directly-exposed deploy is unaffected.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy && trustProxy.trim()) {
    const hops = Number(trustProxy);
    app.set('trust proxy', Number.isNaN(hops) ? trustProxy : hops);
  }

  // Which hardening applies is derived from what this deployment IS (served over
  // TLS? documenting itself?) rather than from NODE_ENV — the Render host runs
  // NODE_ENV=development deliberately, so the old gate silently dropped HSTS and
  // the CSP on a public internet service. See common/security-posture.ts.
  const posture = resolveSecurityPosture(process.env);

  // Security headers
  app.use(
    (
      _req: unknown,
      res: { setHeader: (k: string, v: string) => void },
      next: () => void,
    ) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader(
        'Permissions-Policy',
        'geolocation=(), microphone=(), camera=()',
      );
      if (posture.hsts) {
        res.setHeader(
          'Strict-Transport-Security',
          'max-age=31536000; includeSubDomains',
        );
      }
      // This service returns JSON only (the SPA is a separate origin), so the
      // strictest possible CSP is also the correct one — the strongest defense
      // against any reflected-content XSS, and the replacement for the deprecated
      // X-XSS-Protection header. Withheld only when Swagger is serving HTML with
      // inline assets that `default-src 'none'` would blank out.
      if (posture.contentSecurityPolicy) {
        res.setHeader('Content-Security-Policy', posture.contentSecurityPolicy);
      }
      next();
    },
  );

  // Note: the global prefix excludes the Better Auth handler (the module adds
  // /api/auth to the prefix exclude list automatically).
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'metrics'] });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Enable CORS. The allowlist (including the Capacitor native origins, which
  // are NOT in CORS_ORIGINS and must not have to be) is built in
  // common/cors-origins.ts, where it is documented and unit-tested.
  const cors = resolveCorsAllowlist(
    process.env.CORS_ORIGINS,
    process.env.NODE_ENV,
  );

  app.enableCors({
    origin: cors.origin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: cors.credentials,
  });

  // Swagger Configuration. Gated on an explicit API_DOCS_ENABLED opt-in, NOT on
  // NODE_ENV: the live Render host runs NODE_ENV=development, so the old condition
  // published Swagger UI at /api and the full OpenAPI document at /api-json to the
  // public internet. Defaulting to off means a missing setting closes the door.
  if (posture.apiDocsEnabled) {
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
void bootstrap();
