-- New audit action for Paystack disputes/chargebacks/refunds.
-- Isolated in its own migration: some Postgres versions disallow ALTER TYPE ADD VALUE
-- in a transaction alongside other DDL. IF NOT EXISTS keeps re-application safe.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAYMENT_DISPUTED';
