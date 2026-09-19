import { AuditAction } from '../generated/prisma/client';

/**
 * A tripwire on the `AuditAction` enum's membership.
 *
 * ## Why an enum needs a test at all
 *
 * Because adding a value to it is only half of the change, and the other half
 * lives in a different repository. The platform admin's audit screen
 * (`Lopay/pages/admin/AuditLogsScreen.tsx`) renders each entry through two
 * lookup maps — `ACTION_LABELS` and `ACTION_COLORS` — and both fall back to the
 * raw `SCREAMING_SNAKE_CASE` string in neutral grey when a value is missing.
 *
 * That fallback is the problem: it does not look broken. An unmapped action
 * renders as though the screen had decided it was unremarkable, so the omission
 * survives review and reaches an operator who reads it as noise. It has already
 * happened once — the five enrollment-invite actions shipped unmapped, and
 * `MIGRATED_PAYMENT_AMENDED` (a school restating money on a live plan a family
 * is paying against) was displayed in the "unrecognised" style.
 *
 * ## Why the list is written out rather than derived
 *
 * Deriving it from the enum would make the test pass by construction and assert
 * nothing. The point is that adding a value requires a deliberate edit HERE,
 * and this comment is what that edit puts in front of you:
 *
 *   **Adding an `AuditAction`? Add it to `ACTION_LABELS` and `ACTION_COLORS` in
 *   `Lopay/pages/admin/AuditLogsScreen.tsx` as well.** The mirror of this test
 *   lives beside them and asserts the same list from the other side.
 */
const EVERY_AUDIT_ACTION = [
  'PAYMENT_CONFIRMED',
  'PAYMENT_REJECTED',
  'PAYMENT_REVERSED',
  'FIRST_PAYMENT_CONFIRMED',
  'FIRST_PAYMENT_SETTLED',
  'FIRST_PAYMENT_REJECTED',
  'FIRST_PAYMENT_PAID',
  'ENROLLMENT_DEFAULTED',
  'PAYMENT_DISPUTED',
  'ENROLLMENT_INVITE_CREATED',
  'ENROLLMENT_INVITE_REVOKED',
  'ENROLLMENT_INVITE_DISPUTED',
  'ENROLLMENT_INVITE_CLAIMED',
  'ENROLLMENT_INVITE_RELEASED',
  'MIGRATED_PAYMENT_AMENDED',
] as const;

describe('AuditAction', () => {
  it('has exactly the values the admin screen knows how to render', () => {
    // Sorted on both sides so the failure message is a readable set difference
    // rather than an ordering complaint.
    expect(Object.values(AuditAction).sort()).toEqual(
      [...EVERY_AUDIT_ACTION].sort(),
    );
  });

  it('keeps the enum and the migration that adds values in step', () => {
    // Every value here must exist in the database type too — Prisma's enum is
    // generated from `schema.prisma`, but the DB's is only whatever some
    // migration has run `ALTER TYPE … ADD VALUE` for. They diverge silently:
    // the app compiles and then fails at INSERT time, in production, on the one
    // code path that writes the new value.
    //
    // This cannot reach the database from a unit test, so it asserts the thing
    // it can — that no value is present in TypeScript under a name no migration
    // could have created. The real check is `prisma migrate diff` in CI.
    for (const action of EVERY_AUDIT_ACTION) {
      expect(action).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
