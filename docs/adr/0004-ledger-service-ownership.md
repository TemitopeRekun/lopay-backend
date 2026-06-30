# ADR 0004 — Money-state transitions live in one LedgerService

**Status:** Accepted
**Date:** 2026-06-30

## Context

Every change to money state — confirming/rejecting/reversing an installment,
settling/rejecting a first payment, reconciling/failing a Paystack charge,
confirming a manual first payment, and defaulting an enrollment (manually or via
the nightly sweep) — followed the same invariant-preserving shape:

> pre-fetch → `$transaction` { guarded conditional `updateMany` (count===0
> aborts, so the transition is exactly-once under concurrency) → atomic balance
> `increment`/`decrement` with clamp → `audit.record(…, tx)` → notify } → emit
> realtime events.

But that shape was **copy-pasted across four services** —
`schools.service.ts`, `admin.service.ts`, `enrollment.service.ts`, and
`scheduler/defaulter-detection.service.ts`. The balance math, the clamp rules
(`COMPLETED` at ≤0; reversal capped at `totalSchoolFee`), the audit
`before`/`after` semantics, and the concurrency guards were duplicated and free
to drift. This was the audit's #1 modularity gap and the highest-value test gap.

## Decision

- **`src/ledger/ledger.service.ts` (`LedgerService`) is the single owner of all
  money-state transitions.** It holds: `confirmPayment`, `rejectPayment`,
  `reversePayment`, `settleFirstPayment`, `rejectFirstPayment`,
  `reconcilePaystackPayment`, `failPaystackPayment`, `confirmFirstPayment`,
  `markEnrollmentAsDefaulted`, and `markEnrollmentDefaultedBySweep`.
- The former owners are now **thin callers** that delegate; controllers, the
  webhook controller, and the scheduler are unchanged. `SchoolPaymentsService`,
  `AdminService`, and `EnrollmentService` keep their non-money responsibilities
  (directory reads, onboarding, enrollment creation, etc.).
- `LedgerModule` imports only `NotificationsModule`, `EventsModule`, and
  `AuditModule` (`PrismaModule` is `@Global`). It is imported by the schools,
  admin, enrollment, and scheduler modules. There is no cycle: nothing the ledger
  depends on imports it back.
- Arithmetic still flows through the `Money` value object
  ([ADR 0001](./0001-integer-kobo-money.md)) and the rates from `fees.ts`
  ([ADR 0002](./0002-fee-policy.md)) — `LedgerService` owns the *transitions*,
  those own the *units* and the *policy inputs*.

## Process: test-first, behavior-preserving

This was the riskiest refactor in the roadmap, so it followed the non-breaking
contract's test-lock rule: characterization tests were written **first** against
the pre-extraction code (red→green), then the logic was moved verbatim and the
**same** assertions were retargeted at `LedgerService`. `ledger.service.spec.ts`
drives a `$transaction` mock that executes its callback against a `tx` double, so
the guarded writes, clamp branches, audit payloads, and `count===0` idempotency
no-ops are all exercised (~97% per-file coverage). Behavior is unchanged.

## Consequences

- Balance math, clamp rules, audit semantics, and concurrency guards have exactly
  one home; a change (or a bug fix) applies to every money path at once.
- The four callers shrank substantially and now read as orchestration, not ledger
  logic. `SchedulerModule` no longer needs `Events`/`Audit` (it only finds
  candidates and logs; the flip is the ledger's).
- New money-state transitions belong in `LedgerService`, added test-first.
- Not yet folded in: the `FeePolicy` consolidation foreshadowed in ADR 0002 and
  the full ledger e2e (`enrollment-recovery.e2e-spec.ts` extension) — tracked as
  remaining Milestone 3 work.
