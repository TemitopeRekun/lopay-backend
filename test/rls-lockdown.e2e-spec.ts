/**
 * Regression guard for the Supabase Data API lockdown.
 *
 * `migration 20260731010000_enable_rls_public_schema` enabled deny-by-default RLS
 * on every `public` table and revoked the PostgREST roles. RLS is per-table and is
 * NOT inherited, so a future migration that adds a table without
 * `ENABLE ROW LEVEL SECURITY` silently re-opens that table to the Data API on
 * Supabase. This suite fails CI in that case, on a real database.
 *
 * Runs against the local Docker Postgres like the other e2e suites. The
 * `anon`/`authenticated` roles exist only on Supabase, so the grant assertions
 * self-skip when they are absent — the RLS assertions are portable and always run.
 * See docs/runbook.md "Supabase Data API lockdown".
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Data API lockdown (real DB)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [PrismaService],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  const publicTables = async () =>
    prisma.$queryRawUnsafe<
      { relname: string; rls: boolean; forced: boolean }[]
    >(
      `SELECT c.relname,
              c.relrowsecurity AS rls,
              c.relforcerowsecurity AS forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY c.relname`,
    );

  const roleExists = async (role: string) => {
    const rows = await prisma.$queryRawUnsafe<{ rolname: string }[]>(
      `SELECT rolname FROM pg_roles WHERE rolname = $1`,
      role,
    );
    return rows.length > 0;
  };

  it('has RLS enabled on EVERY table in the public schema', async () => {
    const tables = await publicTables();
    expect(tables.length).toBeGreaterThan(0);

    const unprotected = tables.filter((t) => !t.rls).map((t) => t.relname);
    // A new table here means a migration forgot `ENABLE ROW LEVEL SECURITY`.
    expect(unprotected).toEqual([]);
  });

  it('never FORCES RLS, which would lock out the owner the app connects as', async () => {
    const tables = await publicTables();
    const forced = tables.filter((t) => t.forced).map((t) => t.relname);
    // Owners bypass RLS unless forced; forcing it would break every query.
    expect(forced).toEqual([]);
  });

  it('leaves no permissive policy that would re-expose rows', async () => {
    const policies = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_policies WHERE schemaname = 'public'`,
    );
    // Deny-by-default is the whole design: no policies means no PostgREST access.
    expect(policies).toEqual([]);
  });

  it('still lets the application role read through RLS', async () => {
    // Proves the lockdown is a no-op for Prisma (owner + rolbypassrls).
    await expect(prisma.user.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(prisma.payment.count()).resolves.toBeGreaterThanOrEqual(0);
  });

  it('grants the PostgREST roles nothing on public (Supabase only)', async () => {
    if (!(await roleExists('anon'))) {
      // Plain Postgres: no Data API, nothing to revoke.
      return;
    }

    const grants = await prisma.$queryRawUnsafe<
      { grantee: string; table_name: string; privilege_type: string }[]
    >(
      `SELECT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')`,
    );
    expect(grants).toEqual([]);
  });

  it('keeps the sensitive auth tables unreadable by anon (Supabase only)', async () => {
    if (!(await roleExists('anon'))) return;

    const [checks] = await prisma.$queryRawUnsafe<
      {
        session: boolean;
        account: boolean;
        truncate_payment: boolean;
        service_role: boolean;
      }[]
    >(
      `SELECT has_table_privilege('anon','public."Session"','SELECT')   AS session,
              has_table_privilege('anon','public."Account"','SELECT')   AS account,
              has_table_privilege('anon','public."Payment"','TRUNCATE') AS truncate_payment,
              has_table_privilege('service_role','public."Payment"','SELECT') AS service_role`,
    );

    // Session tokens → account takeover; Account → password hashes; TRUNCATE is a
    // privilege check that RLS does NOT filter, so it must be revoked outright.
    expect(checks.session).toBe(false);
    expect(checks.account).toBe(false);
    expect(checks.truncate_payment).toBe(false);
    // service_role is intentionally retained — Storage (receipts) uses it.
    expect(checks.service_role).toBe(true);
  });
});
