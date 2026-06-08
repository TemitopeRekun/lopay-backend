import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Security headers
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // Paystack webhook needs the RAW body for HMAC-SHA512 signature verification.
  // Mount the raw parser on the exact path BEFORE the JSON parser; body-parser
  // marks the request as parsed so the JSON parser below skips it.
  app.use(
    '/api/v1/payments/paystack/webhook',
    bodyParser.raw({ type: '*/*', limit: '1mb' }),
  );
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
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

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`Application is running on: ${await app.getUrl()}`);
  logger.log(`API available at: ${await app.getUrl()}/api/v1`);
}
bootstrap();
