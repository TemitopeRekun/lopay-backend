-- Enforce one Account row per (providerId, accountId).
--
-- Better Auth resolves a social sign-in by looking for exactly this pair and
-- inserting only when the lookup misses, so two concurrent Google callbacks for the
-- same identity can both miss and both insert. The duplicate link is then resolved
-- arbitrarily by later reads. This is also the pair that has to be unique for
-- "is this Google identity already attached to a different user?" to be answerable,
-- which is the check that keeps one person's provider identity from being attached
-- to someone else's account.
--
-- Deduplicate before adding the index, or the migration fails on any existing
-- duplicate. Keeps the oldest row of each group (the original link) and deletes the
-- later copies: `ctid` breaks ties for rows sharing a createdAt, so the DELETE is
-- deterministic rather than dependent on scan order.
DELETE FROM "Account" a
USING "Account" b
WHERE a."providerId" = b."providerId"
  AND a."accountId" = b."accountId"
  AND (a."createdAt" > b."createdAt"
       OR (a."createdAt" = b."createdAt" AND a.ctid > b.ctid));

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");
