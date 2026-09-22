import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateEnrollmentInviteDto } from './create-enrollment-invite.dto';

/**
 * The student name and class are identity, not decoration.
 *
 * They form the one-live-invite-per-student key (the partial unique index) and
 * are copied verbatim onto the `Child` row, which is itself unique on
 * `(parentId, fullName, className)`. Whatever reaches the service is what those
 * constraints compare, so normalising here is the difference between one child
 * and two.
 *
 * These are `plainToInstance` rather than end-to-end HTTP because that is
 * precisely what Nest's ValidationPipe does with the request body — the
 * transform under test is the one that actually runs.
 */
describe('CreateEnrollmentInviteDto', () => {
  const base = {
    studentName: 'Ada Lovelace',
    className: 'Basic 1',
    amountAlreadyPaid: 40_000,
    parentPhone: '08012345678',
    installmentFrequency: 'MONTHLY',
    planStartDate: '2026-09-19T12:00:00.000Z',
    termEndDate: '2026-12-19T12:00:00.000Z',
  };

  const build = (over: Record<string, unknown> = {}) =>
    plainToInstance(CreateEnrollmentInviteDto, { ...base, ...over });

  it.each([
    ['leading and trailing space', '  Ada Lovelace  ', 'Ada Lovelace'],
    ['a doubled internal space', 'Ada  Lovelace', 'Ada Lovelace'],
    ['a tab between names', 'Ada\tLovelace', 'Ada Lovelace'],
    ['a newline pasted from a register', 'Ada\nLovelace', 'Ada Lovelace'],
    ['several kinds at once', '  Ada   \t Lovelace \n', 'Ada Lovelace'],
  ])('collapses %s in the student name', (_label, input, expected) => {
    expect(build({ studentName: input }).studentName).toBe(expected);
  });

  it('collapses whitespace in the class name too', () => {
    expect(build({ className: ' Basic   1 ' }).className).toBe('Basic 1');
  });

  it('does NOT fold case', () => {
    // A stored name should read the way its school wrote it. Case-insensitive
    // MATCHING lives in `assertNoLiveInvite`, where it changes what collides
    // without rewriting what anyone typed.
    expect(build({ studentName: 'ada lovelace' }).studentName).toBe(
      'ada lovelace',
    );
  });

  it('leaves an already-clean name untouched', () => {
    expect(build().studentName).toBe('Ada Lovelace');
  });

  it('rejects a name that is only whitespace, rather than storing an empty one', () => {
    const errors = validateSync(build({ studentName: '   ' }));
    expect(errors.map((e) => e.property)).toContain('studentName');
  });

  it('passes a well-formed body', () => {
    expect(validateSync(build())).toHaveLength(0);
  });

  it('uppercases the cadence so "monthly" is accepted', () => {
    const dto = build({ installmentFrequency: 'monthly' });
    expect(dto.installmentFrequency).toBe('MONTHLY');
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('leaves a non-string name alone for the validator to reject', () => {
    // The transform must not turn a wrong type into a plausible-looking string
    // and hide it from `@IsString()`.
    const errors = validateSync(build({ studentName: 42 }));
    expect(errors.map((e) => e.property)).toContain('studentName');
  });
});
