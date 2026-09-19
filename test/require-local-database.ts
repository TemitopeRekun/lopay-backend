/**
 * Refuse to run the end-to-end suites against anything but a local database.
 *
 * Wired as Jest's `globalSetup` for the e2e config, so it runs once before any
 * suite is loaded and covers suites that do not exist yet. Throwing here aborts
 * the whole run before a single connection is opened.
 *
 * ## Why this is not paranoia
 *
 * These suites are destructive by design. They create schools, owners, parents,
 * children, enrollments and payments and delete them again in `afterAll`;
 * `rls-lockdown.e2e-spec.ts` inspects grants and policies. They take their
 * connection from `ConfigModule.forRoot()`, which reads `.env` — the same
 * `.env` a developer points Prisma Studio or a one-off script at, and which on
 * this project has held the deployed Supabase URL. Nothing in between asks
 * whether that is a good idea.
 *
 * The failure mode is silent and total: the suite passes, and it passed by
 * writing to production.
 *
 * ## Detecting the mistake is second best; not making it available is better
 *
 * So this does two things, in order. First it pins `DATABASE_URL` from
 * `test/.env.e2e` (the local Docker credentials, committed — they are the
 * throwaway ones already in `docker-compose.yml`). Because `dotenv` never
 * overwrites a variable that is already in the real environment, and
 * `ConfigModule` follows the same rule, setting it here means `.env` is simply
 * never consulted for the e2e database. The happy path is `docker compose up -d
 * postgres && npm run test:e2e`, with nothing to remember.
 *
 * Then it validates whatever that resolution produced — because a developer who
 * exports `DATABASE_URL` themselves still wins, and that is exactly the case
 * worth checking.
 *
 * ## What counts as local
 *
 * A loopback host, by allow-list rather than by blocking known-bad URLs. The
 * set of databases it is safe to truncate is small and knowable; the set it is
 * not grows every time someone adds an environment. An absent or unparseable
 * URL is refused for the same reason — the guard fails closed or it is not a
 * guard.
 *
 * A tunnel forwarding a remote database to `localhost` would defeat this. That
 * is a deliberate trade: the realistic mistake is a stale `.env`, not a
 * developer who has built an SSH tunnel and forgotten about it.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'dotenv';

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
  'host.docker.internal',
  'postgres',
]);

const HOW_TO_FIX =
  'Run the e2e suites against the local Docker Postgres:\n' +
  '  docker compose up -d postgres\n' +
  '  npm run test:e2e\n' +
  'test/.env.e2e supplies the URL. If you export DATABASE_URL yourself it wins —\n' +
  'and it has to be a loopback host.';

/**
 * Pin `DATABASE_URL` from `test/.env.e2e` unless the real environment already
 * set one. Mirrors dotenv/ConfigModule precedence, so whatever this leaves in
 * `process.env` is what the suites will connect to.
 */
function pinDatabaseUrlFromE2eEnv(): void {
  if (process.env.DATABASE_URL?.trim()) return;
  try {
    const file = readFileSync(join(__dirname, '.env.e2e'), 'utf8');
    const url = parse(file).DATABASE_URL?.trim();
    if (url) process.env.DATABASE_URL = url;
  } catch {
    // Missing or unreadable — the check below reports it as "not configured".
  }
}

/** Throw unless the database the suites will use is on a loopback host. */
export function requireLocalDatabase(): void {
  pinDatabaseUrlFromE2eEnv();

  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      `No DATABASE_URL is configured for the e2e run.\n${HOW_TO_FIX}`,
    );
  }

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(
      `DATABASE_URL could not be parsed, so it cannot be proven local. Refusing to run.\n${HOW_TO_FIX}`,
    );
  }

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run destructive e2e tests against "${host}".\n` +
        'These suites create and delete schools, users, enrollments and payments.\n' +
        HOW_TO_FIX,
    );
  }
}

export default function globalSetup(): void {
  requireLocalDatabase();
}
