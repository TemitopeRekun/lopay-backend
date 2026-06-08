-- Paystack split settlement: each school gets a Paystack subaccount created at
-- onboarding so first payments split automatically (school deposit -> subaccount,
-- platform fee -> main account). bankCode is the Paystack settlement bank code.

ALTER TABLE "School" ADD COLUMN "bankCode" TEXT;
ALTER TABLE "School" ADD COLUMN "paystackSubaccountCode" TEXT;
ALTER TABLE "School" ADD COLUMN "paystackSubaccountActive" BOOLEAN NOT NULL DEFAULT false;

-- Subaccount code is unique per school across the platform.
CREATE UNIQUE INDEX "School_paystackSubaccountCode_key" ON "School"("paystackSubaccountCode");
