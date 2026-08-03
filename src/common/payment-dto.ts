import { Money } from './money';
import { PLATFORM_FEE_RATE } from './fees';

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

/*
 * `paymentCommonFields` is gone. It converted kobo→naira and denormalized the
 * three joined names, but was designed to be SPREAD into a DTO alongside the raw
 * row — and every call site duly spread the row too, which is how the joined
 * `School` record (settlement account and all) reached the wire. `toPaymentView`
 * below replaces it with a projection that cannot be widened by accident.
 */

/** The payment columns the list endpoints select from Postgres. */
export interface PaymentRow extends PaymentMoneyRow {
  id: string;
  enrollmentId: string;
  schoolId: string;
  platformAmount: number;
  schoolAmount: number;
  paymentType: string;
  receiver: string;
  status: string;
  isConfirmed: boolean;
  receiptUrl: string | null;
  paymentDate: Date;
}

/** Every field a payment list exposes to any client. Nothing else is serialized. */
export interface PaymentView {
  id: string;
  enrollmentId: string;
  schoolId: string;
  amount: number;
  amountPaid: number;
  platformFeeAmount: number;
  platformFeePercentage: number;
  schoolAmount: number;
  paymentType: string;
  type: string;
  receiver: string;
  status: string;
  isConfirmed: boolean;
  date: Date;
  paymentDate: Date;
  studentName: string | null;
  childName: string | null;
  className: string | null;
  schoolName: string | null;
  receiptUrl: string | null;
  receiptSignedUrl?: string | null;
}

/**
 * Project a payment row onto the wire.
 *
 * This is an explicit allow-list, deliberately NOT `{ ...payment }`. The list
 * queries join `enrollment → school` only to denormalize a school NAME, but
 * spreading the row carried the whole joined `School` record with it:
 * `accountNumber`, `bankCode`, `paystackSubaccountCode`, `ownerId`, plus the
 * school's email and phone. Those are the exact fields
 * `SchoolPaymentsService.getSchoolBankDetails` authorizes per-caller — because
 * redirecting settlement is a fraud vector — and they were riding along in every
 * parent's payment history for free. Internal payment columns
 * (`paystackReference`, `paystackAccessCode`, `idempotencyKey`) left the same way.
 *
 * So adding a column to the Payment or School model can never widen a response by
 * accident: it appears here or it does not ship.
 *
 * `receiptSignedUrl` is omitted entirely unless a value is supplied — including an
 * explicit `null`, which means "we tried to sign and the object is gone", as
 * distinct from "this caller didn't ask for signed URLs".
 */
export function toPaymentView(
  p: PaymentRow,
  receiptSignedUrl?: string | null,
): PaymentView {
  const childName = p.enrollment?.child?.fullName ?? null;

  return {
    id: p.id,
    enrollmentId: p.enrollmentId,
    schoolId: p.schoolId,
    amount: Money.fromKobo(p.amountPaid).toNaira(),
    amountPaid: Money.fromKobo(p.amountPaid).toNaira(),
    platformFeeAmount: Money.fromKobo(p.platformAmount).toNaira(),
    platformFeePercentage: PLATFORM_FEE_RATE,
    schoolAmount: Money.fromKobo(p.schoolAmount).toNaira(),
    paymentType: p.paymentType,
    type: p.paymentType,
    receiver: p.receiver,
    status: p.status,
    isConfirmed: p.isConfirmed,
    date: p.paymentDate,
    paymentDate: p.paymentDate,
    studentName: childName,
    childName,
    className: p.enrollment?.className ?? null,
    schoolName: p.enrollment?.school?.name ?? null,
    receiptUrl: p.receiptUrl,
    ...(receiptSignedUrl !== undefined ? { receiptSignedUrl } : {}),
  };
}
