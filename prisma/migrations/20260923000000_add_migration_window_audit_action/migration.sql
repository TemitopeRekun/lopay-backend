-- Enum VALUE only. Nothing in this file may USE the value it adds.
--
-- `ALTER TYPE ... ADD VALUE` cannot be referenced by a later statement in the
-- same transaction, and Prisma Migrate wraps each file in one — see
-- 20260919000000_add_enrollment_invite_enum_values for the full note.

-- A platform admin moved a school's free-migration deadline. Audited because it
-- changes what that school can be given for free, which is a commercial
-- decision rather than a configuration tweak: the before/after and the reason
-- have to survive the person who made it.
ALTER TYPE "AuditAction" ADD VALUE 'MIGRATION_WINDOW_CHANGED';
