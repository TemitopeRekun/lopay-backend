# Local infrastructure (Docker)

Canonical, version-controlled definition of the backing services the Lopay
backend needs for local development and the real-DB test suites. This replaces
the ad-hoc `docker run` for `lopay-db` that `LOCAL_DEV.md` previously described.

> **TL;DR**
> ```bash
> cd lopay-backend
> docker compose up -d            # start Postgres (+ Redis)
> npm run migrate:deploy          # apply Prisma migrations
> npx prisma db seed              # create the super-admin
> ```

## Services

| Service | Image | Host port | Required? | Purpose |
|---|---|---|---|---|
| `postgres` (`lopay-db`) | `postgres:16-alpine` | **5434** → 5432 | **Yes** | Primary database. Matches `DATABASE_URL` in `.env`. |
| `redis` (`lopay-redis`) | `redis:7-alpine` | **6379** | No (optional) | Socket.IO multi-instance adapter backend (`REDIS_URL`). |

Defined in [`docker-compose.yml`](../docker-compose.yml). Both services have
healthchecks and named volumes (`lopay-pgdata`, `lopay-redisdata`) so data
survives `docker compose down` (use `down -v` to wipe).

### Why these two, and nothing else

The backend's only self-hosted dependencies are **Postgres** (required) and
**Redis** (optional). Everything else it talks to is an external SaaS that
cannot — and should not — be containerised locally:

- **Supabase** (private receipt storage + signed URLs) — needs your service-role key.
- **Paystack** (split payments) — external API, use the `sk_test_…` key.
- **Firebase Admin** (FCM / storage; no longer used for auth) — needs your service-account key.

Redis is genuinely optional: the app attaches the Redis Socket.IO adapter
**only when `REDIS_URL` is set** (`src/events/redis-io.adapter.ts`,
wired in `src/main.ts`). With no `REDIS_URL`, realtime falls back to the
in-memory adapter — fine for a single local instance. To exercise the
multi-instance path locally, add to `lopay-backend/.env`:

```
REDIS_URL=redis://localhost:6379
```

### Why the app itself isn't in compose

The NestJS app runs on the **host** via `npm run start:dev` (see `LOCAL_DEV.md`),
not as a compose service, because it (a) needs developer-held external secrets
that don't belong in a committed compose file, and (b) relies on host hot-reload
for the dev loop. The compose file deliberately scopes itself to backing infra.

## Credentials & connection strings

These are **throwaway local-only** values (also in `.env` / `LOCAL_DEV.md`) —
never reuse them anywhere real.

| | Value |
|---|---|
| User / password | `lopay` / `lopay` |
| Dev database | `lopaydb` |
| Test database | `lopay_test` (auto-created on first init) |
| Dev URL | `postgresql://lopay:lopay@localhost:5434/lopaydb?schema=public` |
| Test URL | `postgresql://lopay:lopay@localhost:5434/lopay_test?schema=public` |

Port **5434** is chosen to avoid colliding with other local Postgres instances
on 5432/5433/5435.

### The test database

[`docker/postgres-init/01-create-test-db.sql`](../docker/postgres-init/01-create-test-db.sql)
runs **once, on first container init only** (empty data volume) and creates
`lopay_test`. The real-DB e2e suite (`test/*.e2e-spec.ts`) reads the app's
`DATABASE_URL`; by default that points at `lopaydb`. To run e2e against the
isolated DB instead, override it for that run:

```bash
DATABASE_URL="postgresql://lopay:lopay@localhost:5434/lopay_test?schema=public" \
  npm run migrate:deploy   # first time only, to create the schema
DATABASE_URL="postgresql://lopay:lopay@localhost:5434/lopay_test?schema=public" \
  npm run test:e2e
```

> If the volume already existed before this init script was added, the script
> won't have run. Create the DB manually once:
> `docker exec -it lopay-db psql -U lopay -d lopaydb -c "CREATE DATABASE lopay_test;"`

## Migrating off the old ad-hoc `lopay-db` container

`LOCAL_DEV.md` previously created the DB with a raw `docker run … --name lopay-db`.
Compose now owns a container with that **same name**, so remove the old one once:

```bash
docker rm -f lopay-db          # remove the ad-hoc container (data was in it)
docker compose up -d           # compose now owns lopay-db, with a named volume
npm run migrate:deploy && npx prisma db seed   # repopulate the fresh volume
```

(The old ad-hoc container stored data in an anonymous volume; the compose
service uses the named `lopay-pgdata` volume, so a one-time re-migrate/seed is
expected.)

## Everyday commands

```bash
docker compose up -d           # start everything (detached)
docker compose ps              # status + health
docker compose logs -f postgres
docker compose stop            # stop without deleting data
docker compose down            # remove containers, KEEP volumes
docker compose down -v         # remove containers AND wipe all data

# psql into the dev DB
docker exec -it lopay-db psql -U lopay -d lopaydb
# e.g. SELECT action, "entityType", "createdAt" FROM "AuditLog" ORDER BY "createdAt" DESC LIMIT 20;

# redis sanity
docker exec -it lopay-redis redis-cli ping   # -> PONG
```

## Relationship to CI

CI (`.github/workflows/node-ci.yml`) spins up its own `postgres:16` **service
container** on `localhost:5432` with database `lopay_test`, independent of this
compose file. This compose file is for **local** development/testing only; CI
does not use it. Keep the Postgres major version (16) in sync between the two so
local results match CI.
