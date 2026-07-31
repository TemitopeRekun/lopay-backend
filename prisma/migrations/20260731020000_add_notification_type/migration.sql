-- Notification kind, persisted so the recipient's filter tabs are real.
--
-- The parent app has always offered "All / Payments / Announcements" tabs but the
-- backend stored no discriminator, so the client typed EVERY row as a payment:
-- Announcements was permanently empty and platform broadcasts were filed under
-- Payments. Wording cannot separate them (a broadcast is free text), so the kind
-- has to be written at creation time.
--
-- Additive and back-compatible: existing rows default to PAYMENT, which is what
-- they are — every notification written before this migration came from a money
-- event on an enrollment.

CREATE TYPE "NotificationType" AS ENUM ('PAYMENT', 'ALERT', 'ANNOUNCEMENT');

ALTER TABLE "Notification"
  ADD COLUMN "type" "NotificationType" NOT NULL DEFAULT 'PAYMENT';
