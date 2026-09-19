ALTER TYPE "AuditAction" ADD VALUE 'MIGRATION_PAYMENT_RECORDED';

CREATE UNIQUE INDEX "MigrationInvite_schoolId_studentName_className_key"
  ON "MigrationInvite"("schoolId", "studentName", "className");

ALTER TABLE "MigrationInvite" ENABLE ROW LEVEL SECURITY;