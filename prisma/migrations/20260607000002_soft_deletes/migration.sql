-- Soft-delete pattern for financial entities.
-- Hard deletes on School/User are now replaced by setting deletedAt.
-- Existing rows get deletedAt = NULL (live) by default.

ALTER TABLE "School" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "User"   ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Index so active-only queries skip deleted rows cheaply
CREATE INDEX "School_deletedAt_idx" ON "School"("deletedAt");
CREATE INDEX "User_deletedAt_idx"   ON "User"("deletedAt");
