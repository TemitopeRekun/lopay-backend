-- Append-only audit trail for money-state-changing actions.

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM (
  'PAYMENT_CONFIRMED',
  'PAYMENT_REJECTED',
  'PAYMENT_REVERSED',
  'FIRST_PAYMENT_CONFIRMED',
  'FIRST_PAYMENT_SETTLED',
  'FIRST_PAYMENT_REJECTED',
  'ENROLLMENT_DEFAULTED'
);

-- CreateTable
CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL,
  "action" "AuditAction" NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorRole" TEXT,
  "schoolId" TEXT,
  "reason" TEXT,
  "before" JSONB,
  "after" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");
CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");
CREATE INDEX "AuditLog_schoolId_idx" ON "AuditLog"("schoolId");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
