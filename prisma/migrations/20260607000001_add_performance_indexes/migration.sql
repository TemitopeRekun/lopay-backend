-- Payment: schoolId is the hottest filter — every school-facing query scans without this
CREATE INDEX "Payment_schoolId_idx" ON "Payment"("schoolId");

-- Payment: compound covering the pending-installments queue (schoolId + isConfirmed + status)
CREATE INDEX "Payment_schoolId_isConfirmed_status_idx" ON "Payment"("schoolId", "isConfirmed", "status");

-- Payment: enrollmentId FK used in joins and per-enrollment payment history
CREATE INDEX "Payment_enrollmentId_idx" ON "Payment"("enrollmentId");

-- ChildEnrollment: schoolId is the primary filter on every school-admin enrollment query
CREATE INDEX "ChildEnrollment_schoolId_idx" ON "ChildEnrollment"("schoolId");

-- ChildEnrollment: compound for defaulter-detection and dashboard status breakdowns
CREATE INDEX "ChildEnrollment_schoolId_paymentStatus_idx" ON "ChildEnrollment"("schoolId", "paymentStatus");

-- Notification: userId is the sole filter on every notification read/count
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- Notification: compound for unread-count queries
CREATE INDEX "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");
