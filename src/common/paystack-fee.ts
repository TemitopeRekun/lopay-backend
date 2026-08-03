/**
 * Paystack Nigeria fee math, in integer kobo.
 *
 * Paystack charges local-card transactions:  1.5% + ₦100 flat,
 *   - the ₦100 flat is WAIVED when the charged amount is below ₦2,500,
 *   - the processing fee is CAPPED at ₦2,000,
 *   - and Nigerian VAT (7.5%) is charged ON TOP of that processing fee.
 *
 * We "gross up" the amount we charge the parent so that Paystack's fee comes
 * out of neither the platform's 2.5% nor the school's deposit. Given a desired
 * NET (`base` = deposit the parent commits toward fees), we solve for the gross
 * `amountCharged` such that `amountCharged - fee(amountCharged) == base` exactly
 * in integer kobo.
 *
 * VAT is configurable via `PAYSTACK_FEE_VAT_RATE` because whether it is billed on
 * top of, or included in, the quoted rate depends on the merchant agreement. It
 * defaults to Nigeria's 7.5%: modelling it as zero when it is in fact charged makes
 * the platform silently under-recover on EVERY first payment (the gap lands on the
 * main account, which bears the fee). Set it to 0 if your pricing is VAT-inclusive.
 *
 * NOTE: the value returned here is an ESTIMATE. The authoritative fee is the
 * `data.fees` field on the Paystack `charge.success` webhook — reconcile against
 * it for accounting. `LedgerService.reconcilePaystackPayment` records the signed
 * difference on the `lopay_paystack_fee_delta_kobo` gauge; a drift that trends in
 * one direction means this model no longer matches your Paystack pricing.
 */

/** Paystack local-card fee rate (1.5%). */
export const PAYSTACK_RATE = 0.015;
/** Flat fee component in kobo (₦100). */
export const PAYSTACK_FLAT_KOBO = 100_00;
/** Below this charged amount (₦2,500), the flat fee is waived. */
export const PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO = 2_500_00;
/** Maximum PROCESSING fee in kobo (₦2,000), before VAT. */
export const PAYSTACK_FEE_CAP_KOBO = 2_000_00;
/** Nigerian VAT on the processing fee, when not overridden by env. */
export const DEFAULT_PAYSTACK_VAT_RATE = 0.075;

/**
 * VAT rate applied to the processing fee. Read from the environment on each call
 * (not at import time) so a deploy can change it without a rebuild, and so tests
 * can exercise both regimes.  Invalid or out-of-range values fall back to the
 * default rather than silently producing nonsense money.
 */
export function paystackVatRate(): number {
  const raw = process.env.PAYSTACK_FEE_VAT_RATE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PAYSTACK_VAT_RATE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_PAYSTACK_VAT_RATE;
  }
  return parsed;
}

/**
 * Processing fee on `amountKobo`, BEFORE VAT — the 1.5% + ₦100 with the waiver and
 * the ₦2,000 cap applied. The cap applies to this component; VAT then applies to
 * the capped figure.
 */
export function paystackFeeBeforeVat(amountKobo: number): number {
  const flat =
    amountKobo < PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO ? 0 : PAYSTACK_FLAT_KOBO;
  const raw = Math.round(amountKobo * PAYSTACK_RATE) + flat;
  return Math.min(raw, PAYSTACK_FEE_CAP_KOBO);
}

/**
 * Total fee Paystack takes on a charged amount `amountKobo`, VAT included.
 */
export function paystackFee(
  amountKobo: number,
  vatRate: number = paystackVatRate(),
): number {
  const beforeVat = paystackFeeBeforeVat(amountKobo);
  return beforeVat + Math.round(beforeVat * vatRate);
}

export interface GrossUp {
  /** Gross amount to charge the parent (kobo). */
  amountCharged: number;
  /** Paystack fee on `amountCharged` (kobo) — estimate; reconcile with webhook. */
  paystackFee: number;
}

/**
 * How far either side of the linear estimate `grossUp` searches for an exact
 * solution. The estimate is never off by more than a couple of kobo; 32 is a wide
 * margin that keeps the scan trivially cheap (it runs once per payment initiation).
 *
 * Exported so the two fallback paths below can be exercised deterministically: with
 * a window of 0 the search sees only the seed, which forces the surplus branch (seed
 * overshoots) or the throw (seed undershoots). At the real window neither is
 * reachable — an exhaustive sweep finds an exact solution for every base — and a
 * defensive guard that cannot be tested is a guard nobody can trust.
 */
export const GROSS_UP_SEARCH_WINDOW_KOBO = 32;

/**
 * Inverse fee: given a desired NET `baseKobo`, return the gross `amountCharged`
 * (and the fee on it) such that `amountCharged - paystackFee == baseKobo` exactly.
 *
 * ## Why this is a search and not a formula
 *
 * `net(a) = a - fee(a)` is a step function, and with VAT it is **not monotonic**:
 * `fee` rounds twice (the 1.5% and then the VAT on it), so a single extra kobo of
 * `a` can push both roundings up at once and raise the fee by 2 — which *lowers*
 * the net. Worked example at 7.5% VAT:
 *
 *     a=433  fee=6  net=427
 *     a=434  fee=8  net=426   <-- net goes DOWN
 *     a=435  fee=8  net=427
 *
 * A linear estimate plus a one-directional correction cannot cross that step. The
 * earlier implementation only ever decremented, so whenever the estimate landed on
 * the low side of a step it fell through to the defensive throw — a 500 on
 * `initiateFirstPayment` for roughly one deposit amount in 800. So: seed from the
 * closed-form regime solution, then scan a small window for the smallest `a` that
 * nets exactly, which is also the cheapest charge for the parent.
 */
export function grossUp(
  baseKobo: number,
  vatRate: number = paystackVatRate(),
  searchWindowKobo: number = GROSS_UP_SEARCH_WINDOW_KOBO,
): GrossUp {
  if (!Number.isInteger(baseKobo) || baseKobo <= 0) {
    throw new Error(
      `grossUp requires a positive integer kobo base, got ${baseKobo}`,
    );
  }

  // VAT scales both the percentage and the flat component of the fee.
  const withVat = 1 + vatRate;
  const effectiveRate = PAYSTACK_RATE * withVat;

  // Region 1 — charged amount below the flat-fee waiver threshold.
  let seed = Math.ceil(baseKobo / (1 - effectiveRate));
  if (seed >= PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO) {
    // Region 2 — flat fee applies.
    seed = Math.ceil(
      (baseKobo + PAYSTACK_FLAT_KOBO * withVat) / (1 - effectiveRate),
    );
    // Region 3 — the processing fee would exceed the cap; the fee is then a
    // known constant (capped processing fee plus VAT on it).
    if (paystackFeeBeforeVat(seed) >= PAYSTACK_FEE_CAP_KOBO) {
      seed =
        baseKobo +
        PAYSTACK_FEE_CAP_KOBO +
        Math.round(PAYSTACK_FEE_CAP_KOBO * vatRate);
    }
  }

  const from = Math.max(1, seed - searchWindowKobo);
  const to = seed + searchWindowKobo;

  // Smallest amount that nets exactly; failing that, the smallest that nets at
  // least `base` — a step can in principle make an exact net unreachable, and a
  // sub-kobo surplus to the school is the only acceptable rounding direction (a
  // deficit would quietly shortchange the school or the platform's cut).
  let surplus = -1;
  for (let amount = from; amount <= to; amount += 1) {
    const net = amount - paystackFee(amount, vatRate);
    if (net === baseKobo) {
      return {
        amountCharged: amount,
        paystackFee: paystackFee(amount, vatRate),
      };
    }
    if (net > baseKobo && surplus < 0) surplus = amount;
  }

  if (surplus > 0) {
    return {
      amountCharged: surplus,
      paystackFee: paystackFee(surplus, vatRate),
    };
  }

  // Defensive: the window failed to contain any solution, which would mean the
  // seed is badly wrong. Surface rather than settle a wrong amount.
  throw new Error(
    `grossUp found no charge that nets base=${baseKobo} (vat=${vatRate}, seed=${seed})`,
  );
}
