/**
 * The single shape behind the post-payment screen, for BOTH payment rails.
 *
 * The two rails resolve very differently — a first payment is a live Paystack
 * charge whose fate the gateway decides in seconds, while an installment is a
 * bank transfer a human at the school approves hours later — but the parent is
 * asking the same question either way: did my money land, and what happens now?
 * Projecting both onto one shape is what lets one screen answer it without
 * branching on rail at every field.
 *
 * The client renders this verbatim. It does NOT re-derive the outcome from a
 * status string, which is the mistake `enrollment-view.ts` documents at length:
 * every client-side re-derivation of a money figure in this codebase has
 * drifted from the ledger. `state` below is the server's verdict.
 */

/**
 * What the parent should be told, independent of which rail produced it.
 *
 * - `succeeded`  money is confirmed and the plan moved (charge verified, or an
 *                installment the school has approved).
 * - `processing` we hold the money's fate as unknown: a charge Paystack has not
 *                settled, or an installment awaiting school confirmation.
 *                Deliberately NOT a failure — telling a parent whose card was
 *                debited that their payment failed is the worst wrong answer.
 * - `failed`     terminal and the money did not move. Retryable.
 * - `cancelled`  the parent closed the popup. No charge was attempted.
 */
export type PaymentOutcomeState =
  | 'succeeded'
  | 'processing'
  | 'failed'
  | 'cancelled';

export interface PaymentOutcomeView {
  state: PaymentOutcomeState;
  /** FIRST_PAYMENT | INSTALLMENT — drives the copy, never the verdict. */
  paymentType: string;
  /** Naira the parent actually parted with (gross for a card charge). */
  amount: number;
  /** Paystack reference, or the payment id for an installment. Support quotes this. */
  reference: string | null;
  childName: string | null;
  schoolName: string | null;
  className: string | null;
  /**
   * Paystack's own words for a declined charge ("Insufficient funds"), or null.
   * Without this a decline reads "Payment failed. Please try again." — advice
   * that produces an identical decline every time for a blocked card.
   */
  reason: string | null;
  /** Enrollment lifecycle after this payment: PENDING | ACTIVE | COMPLETED | FAILED. */
  enrollmentStatus: string | null;
  /** Naira still owed on the plan once this payment is accounted for. */
  remainingBalance: number | null;
  /** Next scheduled installment (naira), or null when the plan is settled. */
  nextInstallmentAmount: number | null;
  /** ISO yyyy-mm-dd, or null when nothing further is scheduled. */
  nextDueDate: string | null;
}

/**
 * Map a raw payment/verify status onto the parent-facing verdict.
 *
 * `isConfirmed` rather than `status` decides success, matching the one rule the
 * whole ledger projection rests on (see `toEnrollmentView`): money counts when
 * it is confirmed, never merely when a row says SUCCESS. An installment sits at
 * status PENDING until a school owner approves it, so status alone would call
 * a perfectly healthy submission a non-event.
 */
export function derivePaymentOutcomeState(payment: {
  status: string;
  isConfirmed: boolean;
}): PaymentOutcomeState {
  if (payment.isConfirmed) return 'succeeded';
  switch (payment.status) {
    case 'SUCCESS':
      // Confirmed is the authority; a SUCCESS row that is not yet confirmed is
      // still in flight as far as the parent is concerned.
      return 'processing';
    case 'FAILED':
    case 'REVERSED':
      return 'failed';
    default:
      return 'processing';
  }
}
