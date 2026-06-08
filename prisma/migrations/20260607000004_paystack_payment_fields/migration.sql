-- Paystack first-payment transaction fields. Null for manual installment payments.
-- amountCharged = gross paid by parent (deposit + platform fee + grossed-up paystack fee).
-- transactionCharge = flat amount routed to platform main account.
-- paystackFee = actual fee taken by Paystack (reconciled from charge.success webhook).

ALTER TABLE "Payment" ADD COLUMN "paystackReference" TEXT;
ALTER TABLE "Payment" ADD COLUMN "paystackAccessCode" TEXT;
ALTER TABLE "Payment" ADD COLUMN "amountCharged" INTEGER;
ALTER TABLE "Payment" ADD COLUMN "paystackFee" INTEGER;
ALTER TABLE "Payment" ADD COLUMN "transactionCharge" INTEGER;

CREATE UNIQUE INDEX "Payment_paystackReference_key" ON "Payment"("paystackReference");
