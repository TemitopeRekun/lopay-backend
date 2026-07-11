# Contributing — LoPay Backend

## Setup

See the [README](./README.md) for install, Docker, migrate, and seed steps, and
[`../LOCAL_DEV.md`](../LOCAL_DEV.md) for the full local stack. Copy
[`.env.example`](./.env.example) to `.env` — it mirrors the Joi schema in
`src/app.module.ts`, and the app refuses to boot if a required var is missing.

## Branching & PRs

- Work on a branch; open a PR into `master`. Milestone work uses
  `milestone-N-<theme>` branches and is squash-merged.
- CI (`.github/workflows/node-ci.yml`) must be green: lint, the OpenAPI staleness
  check, unit tests + coverage gate, real-DB e2e, and build.
- Keep the diff to one coherent change; nothing half-wired left on `master`.

## The non-breaking contract

Every change must satisfy the roadmap's
[non-breaking contract](./docs/roadmap/README.md):

1. `tsc`/`nest build` and ESLint clean; all existing tests stay green and the
   change adds tests at every layer it touches.
2. DB changes are **expand/contract** — additive migrations only; no destructive
   change without a backfill + dual-read window.
3. Behavior-preserving refactors are **test-locked**: write the characterization
   test first (red→green), then refactor under it.
4. Risky swaps ship dual-path / behind a flag; the old path is removed only once
   the new one is verified.

## Money & the ledger

All money is integer **kobo** via the `Money` value object
([ADR 0001](./docs/adr/0001-integer-kobo-money.md)); rates come from `fees.ts`
([ADR 0002](./docs/adr/0002-fee-policy.md)). Every money-state transition belongs
in `LedgerService` ([ADR 0004](./docs/adr/0004-ledger-service-ownership.md)),
added **test-first**, inside a guarded transaction with an audit record. Don't
mutate balances from feature services.

## The API contract

If you change any HTTP surface, regenerate and commit the spec:

```bash
npm run generate:swagger   # hermetic — no DB/secrets needed
```

CI fails if `openapi.json` is stale. The generator also syncs the frontend's
copy when it is checked out beside this repo
([ADR 0005](./docs/adr/0005-openapi-contract-and-sync.md)); regenerate the
frontend client (`npm run generate:types` there) in the same change.

## Tests

```bash
npm run test        # unit
npm run test:e2e    # real-DB integration (needs Postgres)
npm run test:cov    # unit + coverage gate
```

## Commit style

Short, imperative subject with a scope, e.g.
`feat(observability): add /metrics endpoint`. Explain the *why* in the body.
Reference the milestone where relevant.

## Docs

Record significant decisions as an ADR in [`docs/adr/`](./docs/adr/), keep the
[runbook](./docs/runbook.md) current for anything operational, and add a
[CHANGELOG](./CHANGELOG.md) entry under *Unreleased*.
