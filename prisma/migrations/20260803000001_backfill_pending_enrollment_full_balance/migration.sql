-- Backfill for the PENDING-enrollment balance semantics change.
--
-- Enrollments now open owing the WHOLE school fee: the deposit's school share is
-- credited by LedgerService.creditFirstPaymentToBalance when (and only when) the
-- money is actually confirmed — by the Paystack webhook, an admin settle, or a
-- school owner's manual confirm. Rows created BEFORE this deploy were written
-- under the old rule, with the deposit already netted out at initiation:
--
--     remainingBalance = totalSchoolFee - firstPayment.schoolAmount
--
-- Left as they are, those in-flight enrollments would be credited a SECOND time
-- the moment their first payment confirms, understating the balance by the
-- deposit's school share. This restores them to the full fee so the new credit
-- path lands them exactly where the old pre-netting did.
--
-- The guard is deliberately exact:
--   * only PENDING enrollments with a PENDING, unconfirmed first payment — the
--     one population the new credit path will later decrement;
--   * only rows whose balance still equals the old netting arithmetic, so a row
--     that was manually adjusted (or already migrated) is never touched and the
--     statement is idempotent by construction.
-- Rows that do not match are left alone on purpose; if any exist they are
-- already off-book and belong to reconciliation, not a blind UPDATE.
UPDATE "ChildEnrollment" AS e
SET "remainingBalance" = e."totalSchoolFee"
FROM "Payment" AS p
WHERE p."enrollmentId" = e."id"
  AND p."paymentType" = 'FIRST_PAYMENT'
  AND p."isConfirmed" = false
  AND p."status" = 'PENDING'
  AND e."paymentStatus" = 'PENDING'
  AND e."remainingBalance" = e."totalSchoolFee" - p."schoolAmount";
