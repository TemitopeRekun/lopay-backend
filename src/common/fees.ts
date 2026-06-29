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
