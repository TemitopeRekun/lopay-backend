# Milestone 3 — The money ledger core slice

> Part of the [Roadmap to 10/10](./README.md). Read the shared **non-breaking contract** there.

**Theme:** Give money-movement a single owner and prove its invariants top-to-bottom. The audit's #1 modularity gap and the highest-value test gap converge here.

**Why third:** The riskiest refactor — so it goes only after strict types (M1) and the auth boundary (M2) are locked, and it is done **test-first** so behavior is provably preserved.

**Dimensions advanced:** Modularity 7.5 → 9.0 · Test coverage 7.0 → 8.5 · Code quality 9.0 → 9.5 · Scalability 7.0 → 7.5

---

## Database
- Additive `AuditLog`/balance invariants already exist; no schema change required for the extraction. If PII encryption is pursued, add encrypted columns alongside plaintext (expand phase) here.

## Backend
- **Extract `LedgerService` / `PaymentDomain`** owning every money-state transition: `confirmInstallment`, `rejectPayment`, `reversePayment`, `settleFirstPayment`, `reconcilePaystack`, `failPaystack`, `confirmFirstPayment`, `markDefaulted`. Move the guarded-`updateMany` → atomic inc/dec → `audit.record` → notify → emit blocks out of `schools.service.ts`, `admin.service.ts`, `enrollment.service.ts`, and `defaulter-detection.service.ts`; those become thin callers. *(Modularity issue A)*
- **Unify identity provisioning** into one `SchoolOnboardingService`; `createSchool` and `onboardSchool` both delegate (kills the drifted duplicate saga).
- **Adopt `withTenant` everywhere** (route `admin.service.ts` + `enrollment.service.ts` tenant reads through it) or remove it — pick one.
- Fix the duplicate `PrismaService` provider in `payments/payments.module.ts:10` (import `PrismaModule`); delete the dead `parents`/`students`/`common` empty modules.
- Decompose `enrollChild` / `initiateFirstPayment` (~170 lines each) into `resolve → calc-split → persist → notify` private steps; reuse `buildResumeResponse`.

## Frontend
- Point the payment confirm / reverse / settle UI at the (unchanged) endpoints; no contract change — verify the reversal + audit-log viewer still reconcile against the refactored service.

## Tests (all layers)
- **Backend unit (write FIRST, before extraction):** `schools.service.spec.ts` (confirm/reverse balance recompute, double-confirm idempotency, cross-school authz/IDOR, kobo↔naira); isolated `enrollment.service` units (reconcile idempotency on replay, fee handling, webhook dispatch + dedup). These characterization tests lock current behavior so the extraction can't regress it.
- **Backend e2e:** expand `enrollment-recovery.e2e-spec.ts` for the full ledger via `LedgerService` (confirm → balance → reverse → balance restored → re-confirm).
- **Frontend:** Testing Library tests for the confirm/reverse flows + balance display.

## Docs / Ops
- `docs/adr/0004-ledger-service-ownership.md`. Runbook: reversal procedure, audit-log interpretation.

## Definition of done
One service owns money state; the four callers are thin; all money paths have isolated unit tests + an e2e; `withTenant` is consistent; dead modules gone. Behavior identical (proven by the test-first characterization suite). (Plus the shared non-breaking contract.)
