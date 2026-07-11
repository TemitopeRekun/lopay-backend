/**
 * Emits the OpenAPI 3 spec to `openapi.json` at the backend repo root WITHOUT
 * starting the HTTP server or touching any external infra. Run via:
 *
 *   npx ts-node -r tsconfig-paths/register scripts/generate-swagger.ts
 *   # or the npm script:
 *   npm run generate:swagger
 *
 * The committed `openapi.json` is the single source of truth for the API
 * contract. It is consumed by the frontend `generate:types` script (which runs
 * `openapi-typescript` to produce the typed client `Lopay/src/api.generated.ts`)
 * and guarded by a CI staleness check in both repos. Because the backend and the
 * frontend live in separate git repositories, this script also writes a synced
 * copy into the sibling frontend repo (`../Lopay/openapi.json`) when that repo is
 * checked out next to this one, so the frontend's committed copy can be refreshed
 * in one step. See docs/adr/0005-openapi-contract-and-sync.md.
 *
 * Hermetic by design: the app is created in Nest **preview mode** so no provider
 * is instantiated (no DB/Firebase/Redis connection), and any required env vars
 * that only matter at runtime are given inert fallbacks below. This lets the spec
 * be regenerated deterministically anywhere — a fresh checkout, or CI with no
 * secrets — which is what makes the staleness check meaningful.
 */
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';

// Inert fallbacks for env the module's Joi schema requires but the static spec
// does not depend on. Only fills a var when it is genuinely unset, so a real
// environment is never overridden. Must satisfy the patterns in app.module.ts.
const ENV_FALLBACKS: Record<string, string> = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://spec:spec@localhost:5432/spec?schema=public',
  BETTER_AUTH_SECRET: 'openapi-spec-generation-placeholder-secret-value',
  BETTER_AUTH_URL: 'http://localhost:3001',
  FIREBASE_PROJECT_ID: 'spec',
  FIREBASE_CLIENT_EMAIL: 'spec@example.com',
  FIREBASE_PRIVATE_KEY: 'spec',
  FIREBASE_STORAGE_BUCKET: 'spec.appspot.com',
  PAYSTACK_SECRET_KEY: 'sk_test_openapispecgenerationplaceholder',
};
for (const [key, value] of Object.entries(ENV_FALLBACKS)) {
  if (!process.env[key]) process.env[key] = value;
}

async function generate() {
  // Imported dynamically, AFTER the env fallbacks above are applied — a static
  // import is hoisted and would evaluate app.module.ts (and its config-validation
  // schema) against the un-patched env.
  const { AppModule } = await import('../src/app.module');

  // preview:true builds the module/route graph for spec extraction but does NOT
  // instantiate providers — so nothing connects to Postgres, Firebase or Redis.
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  // Kept in lockstep with the runtime Swagger config in src/main.ts so the
  // committed spec matches what the server serves at /api.
  const config = new DocumentBuilder()
    .setTitle('LoPay API')
    .setDescription('The LoPay API documentation for frontend integration')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const json = JSON.stringify(document, null, 2) + '\n';

  // Source of truth: the backend repo root.
  const backendOut = resolve(__dirname, '../openapi.json');
  writeFileSync(backendOut, json);
  console.log(`✅  OpenAPI spec written to ${backendOut}`);

  // Convenience sync: refresh the frontend repo's committed copy when it is
  // checked out as a sibling. Skipped (not an error) when it isn't — e.g. in the
  // backend's own CI, where only this repo is present.
  const frontendOut = resolve(__dirname, '../../Lopay/openapi.json');
  if (existsSync(dirname(frontendOut))) {
    writeFileSync(frontendOut, json);
    console.log(`↪  Synced copy written to ${frontendOut}`);
  }

  await app.close();
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
