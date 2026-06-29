# Lopay — Roadmap to 10/10

**Date:** 2026-06-29
**Source:** Derived from `PRODUCT_AUDIT_2026-06-29.md` (overall ≈5.9/10).
**Goal:** Take every audit dimension to 10/10 through five vertical slices. Each milestone is a **complete slice that works end-to-end across all layers** (database → backend → frontend → tests → docs) and is **independently shippable without breaking the code**.

## The five milestones

| # | Milestone | Theme | Doc |
|---|---|---|---|
| 1 | Foundation | Strict types, domain constants, test + CI harness | [milestone-1-foundation.md](./milestone-1-foundation.md) |
| 2 | Secure delivery & auth | Close externally-reachable security findings | [milestone-2-secure-delivery.md](./milestone-2-secure-delivery.md) |
| 3 | Ledger core | Single owner of money-state, proven invariants | [milestone-3-ledger-core.md](./milestone-3-ledger-core.md) |
| 4 | Scale | Multi-instance safety + DB/cache performance | [milestone-4-scale.md](./milestone-4-scale.md) |
| 5 | Contract, docs & observability | Self-describing, documented, full-journey E2E | [milestone-5-contract-docs.md](./milestone-5-contract-docs.md) |

Milestones are ordered so each depends **only** on the ones before it. M1's strict types + test gate are what make the M3 ledger refactor and M4 perf work safe — keep the order rather than parallelizing.

## Non-breaking contract (applies to every milestone)

Every milestone must satisfy this before it's "done":

1. `tsc --noEmit` clean on both repos; ESLint clean; `nest build` + `vite build` succeed.
2. All existing tests stay green **and** the slice adds new tests at every layer it touched.
3. DB changes are **expand/contract** — additive migrations only (new columns/indexes/tables); no destructive change without a backfill + dual-read window.
4. Behavior-preserving refactors are **test-locked**: write the characterization test first (red→green), then refactor under it.
5. Risky swaps (e.g. token storage) ship **dual-path / behind a flag**; the old path is removed only in a later milestone once verified.
6. Each slice is mergeable on its own; nothing half-wired is left in `main`/`master`.

## Dimension trajectory

| Dimension | Now | M1 | M2 | M3 | M4 | M5 |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Security | 8.0 | 8.0 | **9.5** | 9.5 | 9.5 | **10** |
| Code quality | 7.5 | **9.0** | 9.0 | **9.5** | 9.5 | **10** |
| Test coverage | 3.5 | **6.0** | 7.0 | **8.5** | 9.0 | **10** |
| Modularity | 6.5 | 7.0 | 7.5 | **9.0** | 9.5 | **10** |
| Scalability | 7.0 | 7.0 | 7.0 | 7.5 | **9.5** | **10** |
| Documentation | 3.0 | 4.0 | 5.0 | 6.0 | 6.5 | **10** |

## Which audit findings each milestone closes

| Milestone | Closes (from `PRODUCT_AUDIT_2026-06-29.md`) |
|---|---|
| **M1 Foundation** | Code-quality: strict tsconfig, `any` sprawl, fee-constant duplication, DTO-mapper dup, FE error-block dup. Test: coverage gate, e2e-in-CI, FE test tooling, guard specs. |
| **M2 Secure delivery** | Security: Gemini key leak (HIGH), SPA CSP/SRI + token storage (MED), public-`/schools` PII, `/verify` scoping, PATCH/PUT + dead-route tidy, DB TLS pin. Test: webhook + auth-boundary specs. |
| **M3 Ledger core** | Modularity: ledger ownership, provisioning dup, `withTenant` consistency, duplicate provider, dead modules, fat services. Test: `schools.service`/`enrollment.service` units + ledger e2e. |
| **M4 Scale** | Scalability: unbounded admin lists, in-memory rate limiters, missing indexes, no caching, pool sizing, circuit breaker. Test: pagination/cache/scheduler/perf. |
| **M5 Contract & docs** | Documentation: stale READMEs/API_GUIDEs/`.env.example`/CI, uncommitted OpenAPI/client, missing CONTRIBUTING/CHANGELOG/ADR/runbook. Test: contract + full Playwright journey + 80% gate. Observability + NDPR finalization. |
