import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration, plus a guard on the commands that can destroy a
 * database.
 *
 * ## Why the guard lives here
 *
 * This file is the one chokepoint every Prisma CLI invocation in this repo
 * passes through — `npx prisma …`, `npm run migrate:deploy`, the Dockerfile's
 * boot command, and CI alike. Nothing else sees them all.
 *
 * `test/require-local-database.ts` already refuses to run the destructive e2e
 * suites against a non-local database, and its header explains why that mattered
 * enough to build: these suites take their connection from `.env`, and on this
 * project `.env` has held the deployed Supabase URL, so a stale one meant a
 * green run that passed by writing to production.
 *
 * That guard covered Jest and stopped there — which left the *more* dangerous
 * tool uncovered. `prisma migrate reset` reads the same `.env` and drops every
 * table in the schema; `db push` rewrites it to match `schema.prisma` without a
 * migration. A developer who has just been told their e2e run is safely
 * sandboxed has every reason to assume the CLI beside it is too, and it is not.
 *
 * This is not hypothetical: `npx prisma migrate deploy`, typed in this repo
 * while the local Postgres was up, connected to
 * `aws-0-eu-central-1.pooler.supabase.com` — the production pooler — because
 * `.env` says so and nothing asked. That command is idempotent and applied
 * nothing, so it did no harm. `migrate reset` one line later would have.
 *
 * ## Why it refuses so little
 *
 * Only the commands a developer runs against their own machine, and only when
 * the target is not on that machine. Everything else is untouched, and
 * `migrate deploy` is deliberately, permanently absent from the list:
 *
 *   - the Dockerfile's `CMD` runs `npx prisma migrate deploy` at every boot;
 *   - `.github/workflows/node-ci.yml` runs it twice.
 *
 * Refusing it would break production deploys to prevent an accident it cannot
 * cause — it only ever applies migrations forward, and applying them to
 * production is its entire job. A guard that stops a deploy is worse than the
 * thing it guards against.
 */

/**
 * Hosts that are the developer's own machine.
 *
 * An allow-list, not a block-list of known-bad URLs, for the reason
 * `require-local-database.ts` gives: the set of databases it is safe to drop is
 * small and knowable, while the set it is not grows every time someone adds an
 * environment. Kept in step with that file by hand — the runtime image copies
 * `prisma/` and `prisma.config.ts` but NOT `src/` or `test/`, so importing a
 * shared module from here would resolve in development and fail at container
 * boot, which is exactly the trade `claim-url.ts` and `utils/claimUrl.ts` make
 * for the same reason.
 */
const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
  'host.docker.internal',
  'postgres',
]);

/**
 * Commands that can lose data, as the CLI spells them.
 *
 * `migrate dev` is here because it offers to reset when it finds drift, and the
 * prompt is easy to accept on autopilot. `db execute` is here because it runs
 * arbitrary SQL. `db seed` is here because seeding a live database is not
 * destructive in the CLI's sense and is catastrophic in every other.
 */
const DESTRUCTIVE_COMMANDS = [
  'migrate reset',
  'migrate dev',
  'db push',
  'db execute',
  'db seed',
];

/** Escape hatch, for the rare deliberate case. Named so it cannot be typed by accident. */
const OVERRIDE = 'I_KNOW_THIS_TARGETS_A_REMOTE_DATABASE';

function assertSafeTarget(url: string | undefined): void {
  // Positional arguments only: `--force`, `--schema=…` and friends must not
  // change which command this thinks it is looking at.
  const command = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith('-'))
    .join(' ');

  const destructive = DESTRUCTIVE_COMMANDS.find((candidate) =>
    command.startsWith(candidate),
  );
  if (!destructive) return;

  if (process.env[OVERRIDE] === 'yes') {
    console.warn(
      `⚠️  ${OVERRIDE} is set — running "prisma ${destructive}" without the host check.`,
    );
    return;
  }

  // Fail closed. An absent or unparseable URL cannot be proven local, and a
  // guard that waves through the cases it cannot read is not a guard.
  let host: string;
  try {
    host = new URL(url ?? '').hostname;
  } catch {
    throw new Error(
      `Refusing to run "prisma ${destructive}": DATABASE_URL is missing or unparseable, ` +
        'so it cannot be proven to be a local database.',
    );
  }

  if (LOOPBACK_HOSTS.has(host)) return;

  throw new Error(
    `\n\nRefusing to run "prisma ${destructive}" against "${host}".\n\n` +
      'That is not a local database, and this command can destroy data.\n' +
      'DATABASE_URL comes from .env, which on this project has held the deployed URL.\n\n' +
      'For local work, point it at the Docker Postgres:\n' +
      '  docker compose up -d postgres\n' +
      '  DATABASE_URL="postgresql://lopay:lopay@localhost:5434/lopaydb?schema=public" npx prisma ' +
      `${destructive}\n\n` +
      `If you genuinely mean to target ${host}, set ${OVERRIDE}=yes.\n`,
  );
}

const databaseUrl = process.env['DATABASE_URL'];
assertSafeTarget(databaseUrl);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node prisma/seed.ts',
  },
  datasource: {
    url: databaseUrl,
  },
});
