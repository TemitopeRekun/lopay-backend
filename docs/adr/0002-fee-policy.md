# ADR 0002 — Fee policy lives in one module

**Status:** Accepted
**Date:** 2026-06-29

## Context

Lopay's commercial rules are a **2.5% platform fee** and a **minimum 25%
first-payment deposit**, with installment plans of **12 weekly** or **3 monthly**
payments. These magic numbers (`0.025`, `0.25`, `12`, `3`) had been redeclared as
local constants across `payment.service.ts` (three sites), `admin.service.ts`,
and `enrollment.service.ts`. Changing the fee policy meant editing several files
and keeping them in sync by hand — and `admin.service.ts` had already drifted to
a hardcoded `platformFeePercentage: 0.025` literal in a DTO.

## Decision

- **`src/common/fees.ts` is the single source of truth** for the rates and
  cadence:
  - `PLATFORM_FEE_RATE = 0.025`
  - `FIRST_PAYMENT_DEPOSIT_RATE = 0.25`
  - `WEEKLY_INSTALLMENTS = 12`
  - `MONTHLY_INSTALLMENTS = 3`
- Every service imports these instead of redeclaring them. The rate is surfaced
  to the client via the existing `platformFeePercentage` API field, so the
  frontend never hardcodes it either (verified: no `0.025`/`0.25` literal exists
  in the frontend).
- The *arithmetic* still flows through the `Money` value object (see
  [ADR 0001](./0001-integer-kobo-money.md)); `fees.ts` holds only the policy
  inputs that drive it.

## Consequences

- A fee-policy change is a one-line edit in `fees.ts`.
- `fees.ts` has a 100% per-file coverage gate (`package.json`
  `coverageThreshold`).
- Future work (Milestone 3) folds these into a `FeePolicy`/`LedgerService` so the
  rules and the money-state transitions they drive share one owner.
