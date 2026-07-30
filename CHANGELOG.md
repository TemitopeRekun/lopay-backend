# Changelog

All notable changes to the LoPay backend. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project is
pre-1.0; entries are grouped by the roadmap milestone that shipped them
(see [`docs/roadmap/`](./docs/roadmap/)).

## [Unreleased] — Milestone 5: contract, docs & observability

### Added
- Committed `openapi.json` as the source-of-truth API contract; hermetic
  `generate:swagger` (Nest preview mode, no DB/secrets) with a CI staleness
  check ([ADR 0005](./docs/adr/0005-openapi-contract-and-sync.md)).
- Prometheus `/metrics` endpoint with payment volume, confirm-latency, and
  failure metrics recorded by the ledger; hourly leader-locked
  "confirmations stalled > 1h" Sentry alert.
- `@ApiTags`/`@ApiOperation`/`@ApiBearerAuth` across all controllers so the spec
  is self-describing (60 operations tagged, summarised, and secured).
- `CONTRIBUTING.md` and this changelog.

### Changed
- Rewrote `README.md`, `API_GUIDE.md`, and `.env.example` to match the shipped
  system (Better Auth, `/api/v1`, port 3001, Firebase-Storage receipts,
  Paystack); the API guide now defers endpoint detail to the OpenAPI spec.

## [Milestone 4] — Scale & performance — 2026-06-30

### Added
- Additive performance indexes (`Payment`, `User`, `School`); `DATABASE_POOL_MAX`.
- Redis-backed rate limiters, cache, and Socket.IO adapter, all gated on
  `REDIS_URL` (in-process fallback otherwise).
- `opossum` circuit breaker around Paystack calls.

### Changed
- All admin list endpoints are paginated with a capped `{ items, total, page,
  limit, totalPages }` envelope; signed-URL fan-out bounded to the page.

## [Milestone 3] — Ledger core — 2026-06-30

### Changed
- `LedgerService` is the single owner of every money-state transition; feature
  services are thin callers ([ADR 0004](./docs/adr/0004-ledger-service-ownership.md)).
- Unified school provisioning; removed a duplicate Prisma provider and dead
  modules.

## [Milestone 2] — Secure delivery & auth — 2026-06-29

### Added
- Dual-path Better Auth (cookie + bearer), auth-boundary and webhook tests
  ([ADR 0003](./docs/adr/0003-firebase-to-better-auth.md)).

### Fixed
- Public `/schools` PII exposure; `/verify` scoping; removed a leaked key.

### Security
- Strict SPA CSP and security headers.

## [Milestone 1] — Foundation — 2026-06-29

### Added
- Strict TypeScript, domain fee constants, the test harness, a coverage gate,
  and CI.
