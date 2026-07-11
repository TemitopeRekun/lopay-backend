# LoPay Backend

LoPay is a **school-fee installment platform**: parents pay school fees flexibly,
schools receive confirmed settlements, and the platform earns a fixed service
fee. This NestJS service is the system of record — it owns auth, the money
ledger, Paystack settlement, and the audit trail.

> **Integrating a client?** Start with the **[API Guide](./API_GUIDE.md)** for the
> mental model, then use the committed **[`openapi.json`](./openapi.json)** (or the
> Swagger UI at `/api` in non-production) as the authoritative endpoint reference.

---

## User roles

- **SUPER_ADMIN** — platform owner. Login only (no signup). Onboards schools and
  their owner accounts, receives first payments, settles the school share, sees
  global analytics.
- **SCHOOL_OWNER** — created by an admin; owns exactly one school. Manages class
  fees, confirms/reverses installment payments, marks enrollments defaulted.
- **PARENT** — public signup. Enrols children, makes first + installment
  payments, tracks history and notifications.

## Money model

- **Platform fee:** 2.5% of the total school fee, fixed at enrollment.
- **Minimum first payment:** 25% of the school fee, collected with the platform
  fee up front: `minimumDeposit = 25% of fee + 2.5% platform fee`.
- All amounts are integer **kobo** end-to-end via the `Money` value object
  ([ADR 0001](./docs/adr/0001-integer-kobo-money.md)); rates live in one place
  ([ADR 0002](./docs/adr/0002-fee-policy.md)).
- Every money-state transition (confirm / reject / reverse / settle / reconcile /
  default) is owned by a single `LedgerService`
  ([ADR 0004](./docs/adr/0004-ledger-service-ownership.md)) and written inside a
  guarded transaction with an append-only audit record.

## Tech stack

| Layer | Technology |
| :-- | :-- |
| Framework | NestJS (Node 22) |
| Language | TypeScript (strict) |
| Database | PostgreSQL + Prisma |
| Auth | **Better Auth** (session cookie / bearer) — [ADR 0003](./docs/adr/0003-firebase-to-better-auth.md) |
| Payments | Paystack (split charges) |
| Storage / Push | Firebase Admin (receipts in Storage, FCM) — **not** auth |
| Realtime | Socket.IO (Redis adapter when scaled) |
| Validation | class-validator + Joi (env) |
| Observability | Prometheus (`/metrics`) + Sentry |

## API surface

- Base path **`/api/v1`** for the app API (e.g. `GET /api/v1/users/me`).
- Auth handler mounted at **`/api/auth/*`** (Better Auth), outside the prefix.
- `GET /health` — liveness + DB/storage checks. `GET /metrics` — Prometheus.
- Swagger UI at `/api` in non-production; the spec is committed as
  [`openapi.json`](./openapi.json) and CI fails if it drifts from the code.
- Default port **3001**.

---

## Setup

```bash
npm install
cp .env.example .env        # then fill it in — see .env.example (mirrors the Joi schema)
```

Bring up Postgres (and optional Redis) with Docker, then migrate + seed:

```bash
docker compose up -d
npm run migrate:deploy
npx prisma db seed
```

See [`../LOCAL_DEV.md`](../LOCAL_DEV.md) and [`docs/infrastructure.md`](./docs/infrastructure.md)
for the full local setup.

## Running

```bash
npm run start:dev     # watch mode
npm run start:prod    # compiled (dist/)
```

## Testing

```bash
npm run test          # unit
npm run test:e2e      # real-DB integration (needs Postgres; see LOCAL_DEV.md)
npm run test:cov      # unit + coverage gate
```

## API contract

```bash
npm run generate:swagger   # regenerate openapi.json (hermetic — no DB/secrets needed)
```

Commit the regenerated `openapi.json`; a CI check fails the build if it is stale.
When it is checked out beside the frontend repo, the generator also syncs the
frontend's copy so `npm run generate:types` there stays in step
([ADR 0005](./docs/adr/0005-openapi-contract-and-sync.md)).

## Documentation

- [API Guide](./API_GUIDE.md) — integration mental model.
- [Architecture Decision Records](./docs/adr/) — auth, money, ledger, contract.
- [Operations Runbook](./docs/runbook.md) — auth/cookie cutover, scaling toggles,
  reversals, observability + alerting.
- [Roadmap](./docs/roadmap/) — the five-milestone plan to 10/10.
- [Contributing](./CONTRIBUTING.md) · [Changelog](./CHANGELOG.md)
