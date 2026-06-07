-- AlterTable: add idempotency key to prevent duplicate payment records on network retries
-- Clients must generate a unique key (e.g. UUID v4) per payment attempt and include it in the request.
-- A second request with the same key returns the existing record instead of creating a duplicate.
ALTER TABLE "Payment" ADD COLUMN "idempotencyKey" TEXT;

-- Unique constraint ensures the database rejects duplicates even if the application layer misses them.
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");
