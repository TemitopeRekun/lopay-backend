/**
 * Dumps the OpenAPI JSON spec to `openapi.json` at the project root WITHOUT
 * starting the HTTP server. Run via:
 *
 *   npx ts-node -r tsconfig-paths/register scripts/generate-swagger.ts
 *
 * Or the npm script:  npm run generate:swagger
 *
 * The output file is consumed by the frontend `generate:types` script which
 * calls `openapi-typescript` to produce a typed client (`Lopay/api.generated.ts`).
 */
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { AppModule } from '../src/app.module';

async function generate() {
  // Create the app without starting the HTTP server.
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1');

  const config = new DocumentBuilder()
    .setTitle('LoPay API')
    .setDescription('LoPay platform — school-fee installment API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);

  const outPath = resolve(__dirname, '../../openapi.json');
  writeFileSync(outPath, JSON.stringify(document, null, 2));

  console.log(`✅  OpenAPI spec written to ${outPath}`);
  await app.close();
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
