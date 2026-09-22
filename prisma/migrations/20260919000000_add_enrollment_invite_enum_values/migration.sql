-- Enum VALUES only. Nothing in this file may USE the values it adds.
--
-- `ALTER TYPE ... ADD VALUE` is special: Postgres will not let a value added
-- inside a transaction block be referenced by any later statement in that same
-- transaction. Prisma Migrate wraps each migration file in one transaction, so a
-- file that both adds `MIGRATED_PAYMENT` and, say, inserts a row using it fails
-- at apply time — and on Postgres older than 12 the ALTER itself is rejected
-- outright.
--
-- Keeping the additions in their own file makes both problems structurally
-- impossible rather than a thing reviewers have to notice. The companion
-- migration (…_add_enrollment_invites) creates the table and may reference
-- these freely, because by then this transaction has committed.

-- Money a parent paid the school before it adopted Lopay. See the doc comment on
-- PaymentType in schema.prisma for why this is modelled as a deposit and not as
-- an installment.
ALTER TYPE "PaymentType" ADD VALUE 'MIGRATED_PAYMENT';

-- Audit actions for the invite lifecycle. Every state change an invite can
-- undergo is auditable, because each one either moves money or changes who is
-- able to move it.
ALTER TYPE "AuditAction" ADD VALUE 'ENROLLMENT_INVITE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'ENROLLMENT_INVITE_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'ENROLLMENT_INVITE_DISPUTED';
ALTER TYPE "AuditAction" ADD VALUE 'ENROLLMENT_INVITE_CLAIMED';
ALTER TYPE "AuditAction" ADD VALUE 'MIGRATED_PAYMENT_AMENDED';
