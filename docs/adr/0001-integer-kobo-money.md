# ADR 0001 — Money is modeled as integer kobo

**Status:** Accepted
**Date:** 2026-06-29 (documenting a decision in force since the kobo migration)

## Context

Lopay moves real money (school fees, a 2.5% platform fee, Paystack split
settlement). Early code computed amounts in floating-point Naira
(`schoolFees * 0.025`, `.toFixed(2)`) and stored the result in `Int` columns,
which silently truncated or lost precision for arbitrary fee values — the
highest-risk class of bug in a payments product.

## Decision

- **All monetary values are integer kobo** (1 Naira = 100 kobo) everywhere they
  are stored or computed. Every `Int` money column in `schema.prisma`
  (`amountPaid`, `platformAmount`, `remainingBalance`, `amountCharged`, …) holds
  kobo.
- **A single `Money` value object** (`src/common/money.ts`) owns all arithmetic.
  Its constructor throws on a non-integer kobo value, so an accidental float
  surfaces as a bug at its origin instead of being rounded away. Multiplication
  (`percent`) rounds half-up exactly once.
- **The kobo↔naira boundary is the service layer.** DTOs accept/return Naira
  (user-facing); services convert at the edge via `Money.fromNaira` /
  `Money.fromKobo().toNaira()`. The shared `paymentCommonFields` mapper
  (`src/common/payment-dto.ts`) is the single home for the list-response
  conversion so a "kobo shown as naira" (100×) bug can't reappear in one service
  but not another.

## Consequences

- No floating-point drift in stored balances; the Paystack gross-up identity
  (`amountCharged − fee == base`) holds to the kobo (see `paystack-fee.ts`).
- Callers must be disciplined about the boundary: a value crossing into the DB
  must be kobo, a value crossing out to a client must be naira. The value object
  + the shared mapper make the correct path the easy one.
- `money.ts` and `paystack-fee.ts` carry the project's strongest unit coverage
  and a per-file coverage gate (see `package.json` `coverageThreshold`).
