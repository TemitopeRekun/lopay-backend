-- Add a REVERSED state so a confirmed payment can be auditable-undone.
-- Isolated in its own migration because a new enum value cannot be used in the
-- same transaction it is added in.
ALTER TYPE "PaymentTransactionStatus" ADD VALUE IF NOT EXISTS 'REVERSED';
