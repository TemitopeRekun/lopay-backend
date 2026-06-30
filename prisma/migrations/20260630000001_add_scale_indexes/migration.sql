-- Milestone 4 (Scale): additive performance indexes. No data change.
-- Backs the hot read paths that previously triggered sequential scans:
--   * global transaction ordering + the 6-month revenue series  -> Payment(paymentDate)
--   * the Paystack reconciliation sweep                          -> Payment(status, paystackReference, paymentDate)
--   * admin pending/transaction filters                          -> Payment(paymentType, receiver, isConfirmed, status)
--   * admin user listings filtered by role                       -> User(role)
--   * school search / ordering by name                           -> School(name)
-- For very large tables, an operator may instead build these CONCURRENTLY
-- outside a transaction (see docs/runbook.md "Applying the M4 index migration").

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "School_name_idx" ON "School"("name");

-- CreateIndex
CREATE INDEX "Payment_paymentDate_idx" ON "Payment"("paymentDate");

-- CreateIndex
CREATE INDEX "Payment_status_paystackReference_paymentDate_idx" ON "Payment"("status", "paystackReference", "paymentDate");

-- CreateIndex
CREATE INDEX "Payment_paymentType_receiver_isConfirmed_status_idx" ON "Payment"("paymentType", "receiver", "isConfirmed", "status");
