-- Blind index for phone-number uniqueness.
--
-- `User.phoneNumber` is encrypted at rest with randomized AES-256-GCM, so the
-- same number yields a different ciphertext on every write. A unique index on
-- that column would therefore never collide (enforcing nothing) and equality
-- lookups against it cannot match. `phoneHash` is a deterministic keyed digest
-- (HMAC-SHA256 of the canonical +234 form) that can do both.
--
-- Nullable on purpose: rows written before this column existed keep NULL, and
-- Postgres permits unlimited NULLs under a unique index, so those accounts stay
-- valid and are simply exempt from the constraint until backfilled. Run
-- `scripts/backfill-phone-hash.ts` after deploying to close that gap; it reports
-- any pre-existing duplicate numbers rather than silently picking a winner.
ALTER TABLE "User" ADD COLUMN "phoneHash" TEXT;

CREATE UNIQUE INDEX "User_phoneHash_key" ON "User"("phoneHash");
