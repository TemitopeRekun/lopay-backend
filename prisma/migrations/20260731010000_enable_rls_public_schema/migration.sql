-- Close the Supabase Data API (PostgREST) over the `public` schema.
--
-- ## What was wrong
--
-- Supabase exposes `public` through PostgREST at
-- `https://<ref>.supabase.co/rest/v1/<Table>`, authorised as the `anon` (pre-login)
-- or `authenticated` role. On this project those roles held
-- SELECT/INSERT/UPDATE/DELETE/TRUNCATE on EVERY table and RLS was disabled
-- everywhere with no policies. Anyone holding the anon key — a value designed to
-- be published in browsers — could therefore read `Session` (session tokens →
-- impersonate any user, including SUPER_ADMIN), read `Account` (password hashes and
-- OAuth tokens), read every parent/child/payment row, and TRUNCATE the ledger.
--
-- Lopay does not use PostgREST at all: the API is NestJS + Prisma over a direct
-- Postgres connection as the table owner `postgres`, and Supabase Storage (receipts)
-- lives in the separate `storage` schema and is reached with the service-role key.
-- So closing `public` to the PostgREST roles costs the application nothing.
--
-- ## Why BOTH halves below are required
--
-- RLS alone is not sufficient: TRUNCATE is governed by the TRUNCATE privilege and
-- is NOT filtered by row-level security, so a grant-holder could still wipe a table
-- with RLS on. Revoking alone is not sufficient either, because it leaves nothing
-- protecting rows if a grant is ever restored (a dashboard action, a Supabase
-- template, a future "GRANT ALL ON ALL TABLES" pasted into the SQL editor).
--
-- ## Why this is safe for the app
--
-- Every table is owned by `postgres`, and table owners bypass RLS unless the table
-- is set FORCE ROW LEVEL SECURITY (deliberately not used here). The role Prisma
-- connects as additionally carries rolbypassrls. Enabling RLS with zero policies is
-- therefore deny-all for PostgREST and a no-op for Prisma.
--
-- ## Portability
--
-- `anon` / `authenticated` / `service_role` exist only on Supabase. Local Docker
-- Postgres and CI have no such roles, so every statement touching them is guarded
-- by a pg_roles check and skipped there. The RLS loop is plain Postgres and runs
-- everywhere.

-- ─── 1. Deny-by-default RLS on every table in `public` ──────────────────────────
-- Enumerated dynamically rather than hand-listed so no existing table is missed.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    RAISE NOTICE 'RLS enabled on public.%', t.relname;
  END LOOP;
END $$;

-- ─── 2. Revoke the PostgREST roles, now and for future tables ───────────────────
-- The default-privilege revoke is the durable half: a table created by a later
-- Prisma migration inherits the anon/authenticated grants otherwise, silently
-- re-opening everything this migration just closed.
--
-- `service_role` is intentionally left alone — it is never shipped to a browser
-- and the backend's Supabase Storage client authenticates with it.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      RAISE NOTICE 'Role % absent (not a Supabase database) — skipping', r;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);

    -- Stop future objects inheriting access. Applied for both the role Prisma
    -- migrates as (`postgres`) and Supabase's own `supabase_admin`, whose default
    -- ACLs are what currently grant new tables to anon.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);

    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
      RAISE NOTICE 'Could not alter default privileges FOR ROLE postgres for %', r;
    END;

    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
      RAISE NOTICE 'Could not alter default privileges FOR ROLE supabase_admin for %', r;
    END;

    RAISE NOTICE 'Revoked public-schema access from %', r;
  END LOOP;
END $$;
