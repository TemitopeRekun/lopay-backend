-- New audit action for Paystack-settled first payments.
-- Isolated in its own migration: some Postgres versions disallow ALTER TYPE ADD VALUE
-- in a transaction alongside other DDL.

ALTER TYPE "AuditAction" ADD VALUE 'FIRST_PAYMENT_PAID';
