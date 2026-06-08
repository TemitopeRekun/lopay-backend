/**
 * Paystack Nigeria fee math, in integer kobo.
 *
 * Paystack charges local-card transactions:  1.5% + ₦100 flat,
 *   - the ₦100 flat is WAIVED when the charged amount is below ₦2,500,
 *   - the total fee is CAPPED at ₦2,000.
 *
 * We "gross up" the amount we charge the parent so that Paystack's fee comes
 * out of neither the platform's 2.5% nor the school's deposit. Given a desired
 * NET (`base` = deposit the parent commits toward fees), we solve for the gross
 * `amountCharged` such that `amountCharged - fee(amountCharged) == base` exactly
 * in integer kobo.
 *
 * NOTE: the value returned here is an ESTIMATE. The authoritative fee is the
 * `data.fees` field on the Paystack `charge.success` webhook — reconcile against
 * it for accounting. This module exists so we can compute the `transaction_charge`
 * to route to the platform main account at transaction-initialization time.
 */

/** Paystack local-card fee rate (1.5%). */
export const PAYSTACK_RATE = 0.015;
/** Flat fee component in kobo (₦100). */
export const PAYSTACK_FLAT_KOBO = 100_00;
/** Below this charged amount (₦2,500), the flat fee is waived. */
export const PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO = 2_500_00;
/** Maximum total fee in kobo (₦2,000). */
export const PAYSTACK_FEE_CAP_KOBO = 2_000_00;

/**
 * Forward fee: the fee Paystack takes on a charged amount `amountKobo`.
 */
export function paystackFee(amountKobo: number): number {
  const flat =
    amountKobo < PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO ? 0 : PAYSTACK_FLAT_KOBO;
  const raw = Math.round(amountKobo * PAYSTACK_RATE) + flat;
  return Math.min(raw, PAYSTACK_FEE_CAP_KOBO);
}

export interface GrossUp {
  /** Gross amount to charge the parent (kobo). */
  amountCharged: number;
  /** Paystack fee on `amountCharged` (kobo) — estimate; reconcile with webhook. */
  paystackFee: number;
}

/**
 * Inverse fee: given a desired NET `baseKobo`, return the gross `amountCharged`
 * (and the fee on it) such that `amountCharged - paystackFee == baseKobo` exactly.
 *
 * Solves the three fee regimes, then applies a decrement-and-verify pass so the
 * integer-kobo identity holds to the kobo (the parent is charged the smallest
 * integer kobo that nets exactly `base`).
 */
export function grossUp(baseKobo: number): GrossUp {
  if (!Number.isInteger(baseKobo) || baseKobo <= 0) {
    throw new Error(`grossUp requires a positive integer kobo base, got ${baseKobo}`);
  }

  // Region 1 — charged amount below the flat-fee waiver threshold.
  let amount = Math.ceil(baseKobo / (1 - PAYSTACK_RATE));
  if (amount >= PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO) {
    // Region 2 — flat fee applies.
    amount = Math.ceil((baseKobo + PAYSTACK_FLAT_KOBO) / (1 - PAYSTACK_RATE));
    // Region 3 — fee would exceed the cap; fee is then a known constant.
    if (paystackFee(amount) >= PAYSTACK_FEE_CAP_KOBO) {
      amount = baseKobo + PAYSTACK_FEE_CAP_KOBO;
    }
  }

  // Decrement-and-verify: ceil() can overshoot the net by 1 kobo due to the
  // round() in the fee. Trim down until the net is exact (terminates quickly —
  // round changes by at most 1 per 1-kobo step).
  let guard = 0;
  while (amount - paystackFee(amount) > baseKobo && guard < 5) {
    amount -= 1;
    guard += 1;
  }

  const fee = paystackFee(amount);
  if (amount - fee !== baseKobo) {
    // Defensive: should not happen for valid inputs. Surface rather than settle wrong.
    throw new Error(
      `grossUp failed to net base exactly: base=${baseKobo} amount=${amount} fee=${fee}`,
    );
  }

  return { amountCharged: amount, paystackFee: fee };
}
