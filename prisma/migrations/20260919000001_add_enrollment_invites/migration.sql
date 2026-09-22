-- Enrollment invites: onboarding parents who paid the school before Lopay.
--
-- Depends on …_add_enrollment_invite_enum_values having committed first (see the
-- note at the top of that file for why the enum values cannot live here).

CREATE TYPE "EnrollmentInviteStatus" AS ENUM (
  'PENDING', 'DISPUTED', 'CLAIMED', 'REVOKED', 'EXPIRED'
);

CREATE TABLE "EnrollmentInvite" (
  "id"                   TEXT NOT NULL,
  "schoolId"             TEXT NOT NULL,
  "createdByUserId"      TEXT NOT NULL,
  "studentName"          TEXT NOT NULL,
  "className"            TEXT NOT NULL,
  "totalSchoolFee"       INTEGER NOT NULL,
  "amountAlreadyPaid"    INTEGER NOT NULL,
  "phoneNumber"          TEXT NOT NULL,
  "parentPhoneHash"      TEXT NOT NULL,
  "installmentFrequency" "InstallmentFrequency" NOT NULL,
  "planStartDate"        TIMESTAMP(3) NOT NULL,
  "termEndDate"          TIMESTAMP(3) NOT NULL,
  "tokenHash"            TEXT NOT NULL,
  "expiresAt"            TIMESTAMP(3) NOT NULL,
  "status"               "EnrollmentInviteStatus" NOT NULL DEFAULT 'PENDING',
  "disputeReason"        TEXT,
  "disputedAt"           TIMESTAMP(3),
  "revokedAt"            TIMESTAMP(3),
  "revokedByUserId"      TEXT,
  "claimedByUserId"      TEXT,
  "claimedAt"            TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EnrollmentInvite_pkey" PRIMARY KEY ("id"),

  -- Money invariants, enforced by the database and not only by the service, so
  -- no future caller (a script, a backfill, a second service) can write an
  -- invite that claims a parent paid more than the fee or paid a negative sum.
  -- `amountAlreadyPaid = 0` is allowed on purpose: a school may want to migrate a
  -- student who has paid nothing yet so the family lands on a Lopay plan.
  CONSTRAINT "EnrollmentInvite_fee_positive"
    CHECK ("totalSchoolFee" > 0),
  CONSTRAINT "EnrollmentInvite_paid_within_fee"
    CHECK ("amountAlreadyPaid" >= 0 AND "amountAlreadyPaid" <= "totalSchoolFee"),
  -- A plan whose window is inverted would produce meaningless due dates.
  CONSTRAINT "EnrollmentInvite_term_after_start"
    CHECK ("termEndDate" > "planStartDate")
);

CREATE UNIQUE INDEX "EnrollmentInvite_tokenHash_key"
  ON "EnrollmentInvite"("tokenHash");

CREATE INDEX "EnrollmentInvite_schoolId_status_createdAt_idx"
  ON "EnrollmentInvite"("schoolId", "status", "createdAt");

CREATE INDEX "EnrollmentInvite_parentPhoneHash_status_idx"
  ON "EnrollmentInvite"("parentPhoneHash", "status");

CREATE INDEX "EnrollmentInvite_status_expiresAt_idx"
  ON "EnrollmentInvite"("status", "expiresAt");

-- One live invite per (school, student, class) — but re-issuable.
--
-- A plain unique constraint over the three columns would be wrong: it would also
-- block a school from replacing an invite it had revoked because the phone number
-- was a digit out, which is the single most likely correction. A PARTIAL unique
-- index scopes the rule to invites that still mean something:
--
--   PENDING / DISPUTED — live, still claimable, holding the slot
--   CLAIMED            — already became an enrollment; a second one would mint a
--                        duplicate child for the same student
--   REVOKED / EXPIRED  — dead, and deliberately excluded so a re-issue succeeds
--
-- Prisma's schema language cannot express a partial index, so it is created here
-- and documented on the model. `prisma migrate diff` will not try to drop it:
-- it is invisible to the schema comparison, which is exactly why it must never
-- be relied upon as the ONLY guard — `EnrollmentInvitesService.create` checks the
-- same condition first to return a helpful 400 instead of a raw constraint error.
CREATE UNIQUE INDEX "EnrollmentInvite_live_student_key"
  ON "EnrollmentInvite"("schoolId", "studentName", "className")
  WHERE "status" IN ('PENDING', 'DISPUTED', 'CLAIMED');

ALTER TABLE "EnrollmentInvite" ADD CONSTRAINT "EnrollmentInvite_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EnrollmentInvite" ADD CONSTRAINT "EnrollmentInvite_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL rather than RESTRICT on the two nullable actor columns: they are
-- provenance, not integrity. A deleted user must not pin an invite row in place.
ALTER TABLE "EnrollmentInvite" ADD CONSTRAINT "EnrollmentInvite_claimedByUserId_fkey"
  FOREIGN KEY ("claimedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EnrollmentInvite" ADD CONSTRAINT "EnrollmentInvite_revokedByUserId_fkey"
  FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Link the resulting plan back to the invite that produced it. UNIQUE is the
-- backstop behind the conditional claim write: even if two claims somehow both
-- passed the status guard, only one can attach its enrollment.
ALTER TABLE "ChildEnrollment" ADD COLUMN "enrollmentInviteId" TEXT;

CREATE UNIQUE INDEX "ChildEnrollment_enrollmentInviteId_key"
  ON "ChildEnrollment"("enrollmentInviteId");

ALTER TABLE "ChildEnrollment" ADD CONSTRAINT "ChildEnrollment_enrollmentInviteId_fkey"
  FOREIGN KEY ("enrollmentInviteId") REFERENCES "EnrollmentInvite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Close the new table to the Supabase Data API ───────────────────────────────
--
-- Migration 20260731010000 enabled RLS on every table that existed at the time by
-- enumerating them, and revoked the PostgREST roles both now and for future
-- tables. The revoke half carries forward automatically via ALTER DEFAULT
-- PRIVILEGES; ENABLING RLS does not — it is per-table and a new table starts
-- without it. So every migration that adds a table has to do this line, or the
-- new table becomes the only one in `public` without the second layer.
--
-- It matters more here than for most tables: this one holds `parentPhoneHash`
-- (a stable cross-account identifier for a phone number) and `tokenHash`.
-- Deny-all with zero policies is a no-op for Prisma, which connects as the owner.
ALTER TABLE "EnrollmentInvite" ENABLE ROW LEVEL SECURITY;
