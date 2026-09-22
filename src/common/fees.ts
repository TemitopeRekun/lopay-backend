/**
 * Single source of truth for Lopay's fee policy and installment cadence.
 *
 * These rates were previously redeclared as local constants across
 * `payment.service.ts`, `admin.service.ts`, and `enrollment.service.ts`. Keeping
 * them here means the platform-fee / deposit policy is changed in exactly one
 * place. All monetary arithmetic still flows through the `Money` value object;
 * these are only the rates/counts that drive it.
 *
 * See ADR 0002 (fee policy) and ADR 0001 (integer-kobo Money).
 */

/** Platform service fee: 2.5% of the total school fee, fixed at enrollment. */
export const PLATFORM_FEE_RATE = 0.025;

/** Minimum first-payment deposit: 25% of the total school fee. */
export const FIRST_PAYMENT_DEPOSIT_RATE = 0.25;

/** Number of weekly installments (≈ 3 months). */
export const WEEKLY_INSTALLMENTS = 12;

/** Number of monthly installments (3 months). */
export const MONTHLY_INSTALLMENTS = 3;

/**
 * Platform fee charged on a MIGRATED enrollment — a plan created by claiming an
 * enrollment invite, where the parent paid the school directly before the school
 * adopted Lopay.
 *
 * ## Why this is zero, and why it is a named constant rather than a literal
 *
 * `PLATFORM_FEE_RATE` is collected exactly once per enrollment, inside the
 * Paystack split at first payment: the parent's deposit is charged gross, the
 * platform's 2.5% is routed to the main account as `transactionCharge`, and the
 * rest settles to the school's subaccount. Installments afterwards are paid
 * offline straight to the school, so there is no second point of collection.
 *
 * A migrated enrollment has no such moment. The money it records moved between
 * the parent and the school before Lopay existed in that relationship — it never
 * passes through the split, so there is nothing to take a percentage of and no
 * rail on which to take it. Charging anyway would mean either invoicing the
 * school out-of-band or inflating the parent's outstanding balance by a fee they
 * never agreed to, and the second of those would corrupt the arrears book.
 *
 * So the rate is zero, and the consequence is deliberate: **a migrated enrollment
 * earns the platform nothing for its entire life.** That is priced in as customer
 * acquisition — it puts an existing fee-paying family onto a Lopay plan, and the
 * NEXT term's enrollment goes through the normal paid flow.
 *
 * It lives here, next to the rate it deliberately departs from, so that changing
 * migration pricing is a one-line decision taken in the fee policy — not a
 * literal buried in a service, which is what it was when this feature was first
 * drafted.
 */
export const MIGRATED_ENROLLMENT_PLATFORM_FEE_RATE = 0;
