import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strips properties that are not in the DTO
      transform: true, // Automatically transforms payloads to DTO instances
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
  const config = new DocumentBuilder()
    .setTitle('LoPay API')
    .setDescription('The LoPay API documentation for frontend integration')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();
