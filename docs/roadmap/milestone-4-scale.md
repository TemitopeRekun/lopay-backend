# Milestone 4 — Scale & performance slice

> Part of the [Roadmap to 10/10](./README.md). Read the shared **non-breaking contract** there.

**Theme:** Make the system safe to run multi-instance and fast under load, with the DB and caching tuned and perf verified.

**Why fourth:** Optimizes around the now-clean ledger (M3). Index + cache + pagination changes are additive and low-risk once the core is stable.

**Dimensions advanced:** Scalability 7.5 → 9.5 · Test coverage 8.5 → 9.0 · Modularity 9.0 → 9.5 · Documentation 6.0 → 6.5

---

## Database
- Add indexes (additive migration): `Payment(paymentDate)`, `Payment(status, paystackReference, paymentDate)` (sweep), `Payment(paymentType, receiver, isConfirmed, status)` (admin filters), `User(role)`, `School(name)`. *(Scalability HIGH)*
- Size the `pg.Pool` (`prisma.service.ts:15`) via env `max`; add `connection_limit`/`pgbouncer=true` to `DATABASE_URL`; document the PgBouncer plan.

## Backend
- **Cap the unbounded admin lists** (`admin.service.ts:187,331,567`): add `take` (default 50, max 200) + `skip`, return the `{items,total,page,totalPages}` envelope. Give `getOverview` a dedicated `take:10` recent-transactions query instead of materializing all then slicing. *(Scalability CRITICAL)*
- **Move both rate limiters to a shared Redis store** when `REDIS_URL` is set (`@nest-lab/throttler-storage-redis` for `ThrottlerModule`; `rate-limit-redis` for the Better Auth `express-rate-limit`). Gate on `REDIS_URL` so single-instance dev is unaffected. *(Scalability CRITICAL — auth brute-force defense)*
- **Bound the signed-URL fan-out** to the current page (after pagination) or sign lazily per-receipt.
- Add a Redis `CacheModule` for class fees, the Paystack bank list, and dashboard aggregates with short TTLs + explicit invalidation on `createClassFee`.
- Add a circuit breaker (`opossum`) around `PaystackService.request`.

## Frontend
- Update the admin list screens to consume the new paginated `{items,total,totalPages}` envelopes (page controls / infinite scroll). This is the matching half of the backend pagination cap — shipped in the **same** slice so neither side breaks.

## Tests (all layers)
- **Backend unit:** pagination caps (max 200 enforced), cache hit/invalidation, circuit-breaker open/close, scheduler specs (`defaulter-detection`, `paystack-reconciliation`) with fake timers.
- **DB/perf:** an `EXPLAIN ANALYZE` assertion or a lightweight load smoke (autocannon/k6) on `getTransactions` + the sweep query, proving index usage (no seq-scan on `paymentDate`).
- **Frontend:** Testing Library tests for paginated admin lists (page navigation, empty/last page).
- **e2e:** admin list pagination boundary in the real-DB e2e.

## Docs / Ops
- Runbook: Redis/scaling toggles (`REDIS_URL`), connection-pool sizing, read-replica routing plan for analytics, cache TTLs.

## Definition of done
No unbounded query reachable over HTTP; rate limiting and sockets are correct across N instances; hot queries are index-backed (proven by EXPLAIN); FE paginates. Single-instance dev still works unchanged (Redis features gated). (Plus the shared non-breaking contract.)
