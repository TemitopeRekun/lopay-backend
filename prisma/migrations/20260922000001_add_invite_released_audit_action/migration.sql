-- Enum VALUE only. Nothing in this file may USE the value it adds.
--
-- `ALTER TYPE ... ADD VALUE` cannot be referenced by a later statement in the
-- same transaction, and Prisma Migrate wraps each file in one. See
-- 20260919000000_add_enrollment_invite_enum_values for the full note.

-- A school removed a migrated plan that the wrong person claimed. Audited
-- separately from ENROLLMENT_INVITE_REVOKED because the two are not the same
-- event: revoking cancels a link nobody used, while this deletes a live plan,
-- its payment rows and a Child record — and the audit row it writes is the only
-- surviving trace of any of them.
ALTER TYPE "AuditAction" ADD VALUE 'ENROLLMENT_INVITE_RELEASED';
