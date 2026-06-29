import { Money } from './money';

/**
 * A payment row joined with its enrollment → child/school, as returned by the
 * list queries. Fields are optional so every call site's row type (some include
 * a guaranteed enrollment, some use defensive optional chaining) is assignable.
 */
export interface PaymentMoneyRow {
  amountPaid: number;
  enrollment?: {
    className?: string | null;
    child?: { fullName?: string | null } | null;
    school?: { name?: string | null } | null;
  } | null;
}

/**
 * The kobo→naira money conversion + denormalized name fields shared by every
 * payment-list enricher (payments/schools/admin). Spread this into a DTO and add
 * the site-specific fields around it. Single home for the kobo→naira boundary so
 * a `getHistory`-style 100×-display bug can't reappear in one service but not another.
 */
export function paymentCommonFields(p: PaymentMoneyRow) {
  return {
    amount: Money.fromKobo(p.amountPaid).toNaira(),
    amountPaid: Money.fromKobo(p.amountPaid).toNaira(),
    studentName: p.enrollment?.child?.fullName,
    className: p.enrollment?.className,
    schoolName: p.enrollment?.school?.name,
  };
}
