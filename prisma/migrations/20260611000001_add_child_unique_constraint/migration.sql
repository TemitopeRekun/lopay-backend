-- Enforce one Child row per (parentId, fullName, className). A second child with
-- the same name in the same class for the same parent is always a duplicate
-- created by a double-tap/retry, never a real second child.

-- Step 1: clean up any pre-existing duplicates so the unique index can be created.
-- Only ORPHANED duplicates (no ChildEnrollment, hence no payments/financial data)
-- are removed; for each (parentId, fullName, className) group we keep the row that
-- has an enrollment, else the earliest-created row (id as a deterministic tiebreak).
-- If two duplicates BOTH have enrollments (a pathological case), nothing is deleted
-- here and the index creation below will fail loudly rather than lose data.
DELETE FROM "Child" c
WHERE NOT EXISTS (
        SELECT 1 FROM "ChildEnrollment" e WHERE e."childId" = c."id"
      )
  AND EXISTS (
        SELECT 1 FROM "Child" keep
        WHERE keep."parentId" = c."parentId"
          AND keep."fullName" = c."fullName"
          AND keep."className" = c."className"
          AND keep."id" <> c."id"
          AND (
            EXISTS (SELECT 1 FROM "ChildEnrollment" e2 WHERE e2."childId" = keep."id")
            OR keep."createdAt" < c."createdAt"
            OR (keep."createdAt" = c."createdAt" AND keep."id" < c."id")
          )
      );

-- Step 2: add the unique constraint.
CREATE UNIQUE INDEX "Child_parentId_fullName_className_key"
  ON "Child"("parentId", "fullName", "className");
