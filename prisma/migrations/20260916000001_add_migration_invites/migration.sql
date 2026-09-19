CREATE TYPE "MigrationInviteStatus" AS ENUM ('CREATED', 'DISPUTED', 'CLAIMED', 'EXPIRED');

ALTER TABLE "ChildEnrollment" ADD COLUMN "migrationInviteId" TEXT;
CREATE UNIQUE INDEX "ChildEnrollment_migrationInviteId_key" ON "ChildEnrollment"("migrationInviteId");

CREATE TABLE "MigrationInvite" (
  "id" TEXT NOT NULL,
  "schoolId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "claimedByUserId" TEXT,
  "studentName" TEXT NOT NULL,
  "className" TEXT NOT NULL,
  "totalSchoolFee" INTEGER NOT NULL,
  "amountPaid" INTEGER NOT NULL,
  "parentPhoneHash" TEXT NOT NULL,
  "installmentFrequency" "InstallmentFrequency" NOT NULL,
  "migrationDate" TIMESTAMP(3) NOT NULL,
  "termEndDate" TIMESTAMP(3) NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" "MigrationInviteStatus" NOT NULL DEFAULT 'CREATED',
  "disputeReason" TEXT,
  "claimedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MigrationInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MigrationInvite_tokenHash_key" ON "MigrationInvite"("tokenHash");
CREATE INDEX "MigrationInvite_schoolId_status_idx" ON "MigrationInvite"("schoolId", "status");
CREATE INDEX "MigrationInvite_expiresAt_idx" ON "MigrationInvite"("expiresAt");

ALTER TABLE "MigrationInvite" ADD CONSTRAINT "MigrationInvite_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MigrationInvite" ADD CONSTRAINT "MigrationInvite_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MigrationInvite" ADD CONSTRAINT "MigrationInvite_claimedByUserId_fkey"
  FOREIGN KEY ("claimedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChildEnrollment" ADD CONSTRAINT "ChildEnrollment_migrationInviteId_fkey"
  FOREIGN KEY ("migrationInviteId") REFERENCES "MigrationInvite"("id") ON DELETE SET NULL ON UPDATE CASCADE;