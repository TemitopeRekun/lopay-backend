-- Runs ONCE, only on first container init (empty data dir), as the POSTGRES_USER
-- (`lopay`, the instance superuser) against the default `lopaydb` database.
--
-- Creates an isolated test database so the real-DB e2e suite can run without
-- touching local dev data. To use it, point the e2e run at:
--   DATABASE_URL=postgresql://lopay:lopay@localhost:5434/lopay_test?schema=public
--
-- `CREATE DATABASE` cannot run inside a transaction block; keep each as its own
-- statement. `gen_random_uuid()` etc. live in pgcrypto — enable it on both DBs
-- if a migration needs it (Prisma migrations create their own as required).
CREATE DATABASE lopay_test;
GRANT ALL PRIVILEGES ON DATABASE lopay_test TO lopay;
