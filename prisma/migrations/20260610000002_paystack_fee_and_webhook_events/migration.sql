-- Keep the estimated Paystack fee (set at initiation, baked into transactionCharge)
-- separate from the authoritative fee Paystack actually charged the platform
-- account, so the book-vs-bank drift is auditable rather than silently overwritten.
ALTER TABLE "Payment" ADD COLUMN "actualPaystackFee" INTEGER;

-- Persistent, replayable inbound-webhook log (dead-letter + dedup).
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "reference" TEXT,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebhookEvent_dedupeKey_key" ON "WebhookEvent"("dedupeKey");
CREATE INDEX "WebhookEvent_reference_idx" ON "WebhookEvent"("reference");
CREATE INDEX "WebhookEvent_provider_eventType_idx" ON "WebhookEvent"("provider", "eventType");
CREATE INDEX "WebhookEvent_processedAt_idx" ON "WebhookEvent"("processedAt");

-- Leader-election lock for scheduled jobs (single-runner when scaled).
CREATE TABLE "SchedulerLock" (
    "name" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchedulerLock_pkey" PRIMARY KEY ("name")
);

