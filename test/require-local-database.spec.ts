import { requireLocalDatabase } from './require-local-database';

/**
 * The guard that stands between a destructive e2e run and a real database.
 *
 * Worth testing properly rather than trusting, because it only ever fires on
 * the day someone has a deployed URL in `.env` — and on that day there is no
 * second chance. The cases below are the ones that decide whether it holds: a
 * remote host must be refused, an absent or unparseable URL must be refused
 * too (a guard that passes when it cannot tell is not a guard), and the local
 * Docker URL must be allowed or nobody can run the suites at all.
 */
describe('requireLocalDatabase', () => {
  const original = process.env.DATABASE_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  const withUrl = (url: string | undefined) => {
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    return () => requireLocalDatabase();
  };

  it.each([
    'postgresql://lopay:lopay@localhost:5434/lopaydb',
    'postgresql://lopay:lopay@127.0.0.1:5434/lopaydb',
    'postgresql://lopay:lopay@host.docker.internal:5432/lopaydb',
  ])('allows the local database %s', (url) => {
    expect(withUrl(url)).not.toThrow();
  });

  it('refuses a managed/hosted database', () => {
    expect(
      withUrl(
        'postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require',
      ),
    ).toThrow(/Refusing to run destructive e2e tests/);
  });

  it('names the offending host, so the message is actionable', () => {
    expect(withUrl('postgresql://u:p@db.production.internal:5432/app')).toThrow(
      /db\.production\.internal/,
    );
  });

  it.each([
    [
      'a host that merely looks local',
      'postgresql://u:p@localhost.evil.com:5432/db',
    ],
    ['a bare hostname', 'postgresql://u:p@prod-db:5432/app'],
  ])('refuses %s', (_label, url) => {
    expect(withUrl(url)).toThrow(/Refusing to run/);
  });

  it('refuses an unparseable URL rather than assuming it is local', () => {
    expect(withUrl('not a url at all')).toThrow(/cannot be proven local/);
  });

  it('falls back to test/.env.e2e when nothing is exported', () => {
    // The whole point: with DATABASE_URL unset, the suites would otherwise read
    // the developer's `.env`, which on this project has held a deployed URL.
    expect(withUrl(undefined)).not.toThrow();
    expect(process.env.DATABASE_URL).toMatch(/@localhost:5434\/lopay_test/);
  });

  it('lets an explicitly exported URL win over the fallback', () => {
    expect(withUrl('postgresql://u:p@127.0.0.1:5999/other')).not.toThrow();
    expect(process.env.DATABASE_URL).toBe(
      'postgresql://u:p@127.0.0.1:5999/other',
    );
  });
});
