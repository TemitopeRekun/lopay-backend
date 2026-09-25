-- Bound free migration in two directions: per school, and per student.
--
-- Migration carries no platform fee — it is priced as one-time acquisition, on
-- the understanding that the family's NEXT term is a normal paid enrollment.
-- Nothing enforced "one-time", so a school could route every term's families
-- through it and never generate revenue at all.

-- ─── 1. Per school: a window in which invites may be ISSUED ──────────────────
--
-- DEFAULT rather than a bare NOT NULL so a row inserted by any path — the
-- onboarding service, a seed, a future script — gets a sane window instead of
-- failing or, worse, ending up with NULL and an ambiguous rule. The service
-- sets it explicitly too; this is the backstop, not the mechanism.
ALTER TABLE "School"
  ADD COLUMN "migrationDeadline" TIMESTAMP(3) NOT NULL
  DEFAULT (now() + interval '60 days');

-- Existing schools get the window they WOULD have had, measured from their own
-- onboarding — not a fresh 60 days, which would hand a school that joined in
-- March the same allowance as one that joined yesterday.
--
-- GREATEST floors it so the rule can never land retroactively: a school whose
-- computed deadline has already passed (or is about to) gets 14 days from now
-- instead of discovering mid-migration that issuing has stopped. At the time of
-- writing every school in production is inside the computed window and the floor
-- changes nothing — it is here for the ones this migration has not met.
UPDATE "School"
SET "migrationDeadline" = GREATEST(
      "createdAt" + interval '60 days',
      now() + interval '14 days'
    );

-- ─── 2. Per student: migrated once, ever ─────────────────────────────────────
--
-- The existing `EnrollmentInvite_live_student_key` is scoped to
-- (schoolId, studentName, className). That makes a second LIVE invite for the
-- same student in the same class impossible — but className changes every term,
-- so Ada in Basic 1 could be migrated again next year in Basic 2, free, and
-- again the year after. className is therefore the wrong grain for a permanent
-- rule; the student is.
--
-- lower("studentName") rather than the raw column, deliberately diverging from
-- the older index. That one may compare exactly because the service check in
-- front of it is case-insensitive and merely rejects MORE. This one is the
-- permanent, money-bearing rule, and an exact comparison would make "Ada
-- Lovelace" and "ada lovelace" two free migrations for one child — a bypass
-- reachable by retyping a name, which is precisely how the name gets entered.
--
-- Scoped to CLAIMED alone, so a REVOKED claim (see `release`) frees the student
-- to be migrated again. That is the whole point of release: the claim was wrong.
-- Verified against production before adding: zero claimed invites, so no
-- existing row can violate it.
CREATE UNIQUE INDEX "EnrollmentInvite_migrated_student_key"
  ON "EnrollmentInvite"("schoolId", lower("studentName"))
  WHERE "status" = 'CLAIMED';
