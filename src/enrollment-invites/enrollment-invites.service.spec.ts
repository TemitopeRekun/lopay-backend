import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  EnrollmentInviteStatus,
  PaymentStatus,
  UserRole,
} from '../generated/prisma/client';
import { EnrollmentInvitesService } from './enrollment-invites.service';
import { derivePlanEnd } from './invite-policy';
import { hashInviteToken, INVITE_TOKEN_LENGTH } from './invite-token';
import { parseClaimUrlToken } from './claim-url';
import { phoneBlindIndex } from '../common/phone';
import type { AuthUser } from '../common/types/auth-user';
import type { CreateEnrollmentInviteDto } from './dto/create-enrollment-invite.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const PARENT_PHONE = '08012345678';
const PARENT_PHONE_HASH = phoneBlindIndex(PARENT_PHONE)!;

const OWNER: AuthUser = {
  userId: 'owner-1',
  role: UserRole.SCHOOL_OWNER,
  schoolId: 'school-1',
};
const PARENT: AuthUser = { userId: 'parent-1', role: UserRole.PARENT };

/** A syntactically valid token that no invite is keyed to unless a test says so. */
const VALID_TOKEN = 'z'.repeat(INVITE_TOKEN_LENGTH);

type Mocked = Record<string, jest.Mock>;

/**
 * Behavioural suite for the enrollment-invite lifecycle.
 *
 * Prisma, the ledger, audit, notifications and the realtime gateway are mocked:
 * the money arithmetic is proven in `common/migrated-plan.spec.ts` and against a
 * real database in `test/enrollment-invites.e2e-spec.ts`. What is locked here is
 * everything a mock CAN prove and a type cannot — who is allowed to do what, what
 * a refusal says, what is written inside the transaction versus after it, and
 * that a failure on a best-effort path never undoes committed work.
 */
describe('EnrollmentInvitesService', () => {
  let prisma: {
    enrollmentInvite: Mocked;
    school: Mocked;
    classFee: Mocked;
    user: Mocked;
    parent: Mocked;
    child: Mocked;
    $transaction: jest.Mock;
  };
  let ledger: Mocked;
  let audit: { record: jest.Mock };
  let notifications: { create: jest.Mock };
  let events: Mocked;
  let config: { get: jest.Mock };
  let service: EnrollmentInvitesService;
  let tx: typeof prisma;

  const futureDate = (days: number) => new Date(Date.now() + days * DAY_MS);

  const validDto = (
    overrides: Partial<CreateEnrollmentInviteDto> = {},
  ): CreateEnrollmentInviteDto => ({
    studentName: 'Ada Lovelace',
    className: 'Basic 1',
    amountAlreadyPaid: 40_000,
    parentPhone: PARENT_PHONE,
    installmentFrequency: 'MONTHLY',
    planStartDate: new Date(),
    // No termEndDate: it is derived from the start date and the cadence. See
    // `derivePlanEnd` for why it must not be an input.
    ...overrides,
  });

  const storedInvite = (overrides: Record<string, unknown> = {}) => ({
    id: 'invite-1',
    schoolId: 'school-1',
    createdByUserId: 'owner-1',
    studentName: 'Ada Lovelace',
    className: 'Basic 1',
    totalSchoolFee: 10_000_000,
    amountAlreadyPaid: 4_000_000,
    phoneNumber: '+2348012345678',
    parentPhoneHash: PARENT_PHONE_HASH,
    installmentFrequency: 'MONTHLY',
    planStartDate: new Date(),
    termEndDate: futureDate(90),
    tokenHash: hashInviteToken(VALID_TOKEN),
    expiresAt: futureDate(14),
    status: EnrollmentInviteStatus.PENDING,
    disputeReason: null,
    disputedAt: null,
    revokedAt: null,
    claimedAt: null,
    createdAt: new Date(),
    school: { name: 'Acme Academy' },
    ...overrides,
  });

  /**
   * Stub `enrollmentInvite.findFirst` the way the database behaves.
   *
   * `create` now makes TWO lookups through it — "already migrated, any class"
   * (CLAIMED only) and "a live invite for this class" (PENDING/DISPUTED/CLAIMED)
   * — so a mock that ignores `where.status` lets the first answer for the
   * second, and the wrong refusal comes back.
   */
  const stubInviteLookup = (
    row: { status: EnrollmentInviteStatus; className?: string } | null,
  ) =>
    prisma.enrollmentInvite.findFirst.mockImplementation(
      ({ where }: { where: { status?: unknown } }) => {
        if (!row) return Promise.resolve(null);
        const wanted = where.status;
        const matches =
          typeof wanted === 'string'
            ? wanted === row.status
            : Array.isArray((wanted as { in?: unknown[] })?.in)
              ? (wanted as { in: unknown[] }).in.includes(row.status)
              : true;
        return Promise.resolve(matches ? row : null);
      },
    );

  beforeEach(() => {
    prisma = {
      enrollmentInvite: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      school: {
        // One fixture serves both callers: `create` selects id + name to prove
        // ownership, `claim` selects name + ownerId and additionally requires
        // `deletedAt: null` so a school that has left the platform cannot be
        // enrolled into.
        findFirst: jest.fn().mockResolvedValue({
          id: 'school-1',
          name: 'Acme Academy',
          ownerId: 'owner-1',
          // Migration window open by default; the tests that care about it
          // closed say so explicitly.
          migrationDeadline: futureDate(30),
        }),
        findUnique: jest.fn().mockResolvedValue({ ownerId: 'owner-1' }),
      },
      classFee: {
        findFirst: jest.fn().mockResolvedValue({ feeAmount: 10_000_000 }),
      },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ phoneHash: PARENT_PHONE_HASH }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ phoneNumber: '+2348012345678' }),
      },
      // `createMany` + `skipDuplicates` then a read, for exactly the reason
      // `child` below does it: `upsert` is a SELECT-then-INSERT here, so two
      // concurrent claims both insert and the loser's P2002 aborts the whole
      // transaction. See `resolveParent`.
      parent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'parent-row-1' }),
      },
      child: {
        // `createMany` + `skipDuplicates`, not find-then-create and not
        // `upsert`: only that pair emits INSERT … ON CONFLICT DO NOTHING, and a
        // unique violation inside a transaction aborts it so nothing can catch
        // and re-read. See `resolveChild`.
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'child-1' }),
      },
      $transaction: jest.fn(),
    };
    tx = prisma;
    // Callback form runs the body against the same mocks; array form (used by
    // `list`) resolves each promise.
    prisma.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function'
        ? await (arg as (c: unknown) => Promise<unknown>)(tx)
        : await Promise.all(arg as Promise<unknown>[]),
    );

    ledger = {
      recordMigratedEnrollment: jest.fn().mockResolvedValue({
        enrollment: {
          id: 'enrollment-1',
          totalSchoolFee: 10_000_000,
          firstPaymentPaid: 4_000_000,
          remainingBalance: 6_000_000,
          paymentStatus: PaymentStatus.ACTIVE,
          termStartDate: new Date(),
        },
        payment: { id: 'payment-1' },
        figures: {
          remainingBalance: 6_000_000,
          platformFee: 0,
          paymentStatus: PaymentStatus.ACTIVE,
        },
      }),
      announceMigratedEnrollment: jest.fn().mockResolvedValue(undefined),
      amendMigratedPayment: jest.fn().mockResolvedValue({ ok: true }),
      releaseMigratedEnrollment: jest
        .fn()
        .mockResolvedValue({ removedPayments: 1 }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    events = {
      emitEnrollmentsChanged: jest.fn(),
      emitPaymentsChanged: jest.fn(),
    };
    config = {
      get: jest.fn((key: string) =>
        key === 'WEB_APP_URL' ? 'https://app.lopay.test' : undefined,
      ),
    };

    service = new EnrollmentInvitesService(
      prisma as never,
      ledger as never,
      audit as never,
      notifications as never,
      events as never,
      config as never,
    );
  });

  // ================================= create =================================

  describe('create', () => {
    /**
     * The school cannot supply `termEndDate`.
     *
     * It is the cliff that `DefaulterDetectionService` and `computeArrears`
     * both read, so a typed date is wrong in one of two directions: too early
     * defaults the family before instalment one falls due, too late exempts
     * them from defaulting altogether. Time is frozen here so the expected
     * dates can be written out in full rather than recomputed by the
     * assertion — a test that derives its own expectation the same way the
     * code does would pass an off-by-one month.
     */
    describe('the plan end is derived, not supplied', () => {
      const PLAN_START = new Date('2026-09-19T12:00:00.000Z');

      beforeEach(() => {
        jest.useFakeTimers().setSystemTime(PLAN_START);
        prisma.enrollmentInvite.create.mockResolvedValue(storedInvite());
      });
      afterEach(() => {
        jest.useRealTimers();
      });

      const writtenTermEnd = (): Date =>
        prisma.enrollmentInvite.create.mock.calls[0][0].data.termEndDate;

      it('spans three months for a MONTHLY cadence', async () => {
        await service.create(
          validDto({
            planStartDate: PLAN_START,
            installmentFrequency: 'MONTHLY',
          }),
          OWNER,
        );

        expect(writtenTermEnd().toISOString().slice(0, 10)).toBe('2026-12-19');
        expect(writtenTermEnd()).toEqual(derivePlanEnd(PLAN_START, 'MONTHLY'));
      });

      it('spans twelve weeks for a WEEKLY cadence', async () => {
        await service.create(
          validDto({
            planStartDate: PLAN_START,
            installmentFrequency: 'WEEKLY',
          }),
          OWNER,
        );

        // 84 days, so a weekly plan closes BEFORE the monthly equivalent.
        expect(writtenTermEnd().toISOString().slice(0, 10)).toBe('2026-12-12');
        expect(writtenTermEnd().getTime()).toBeLessThan(
          derivePlanEnd(PLAN_START, 'MONTHLY').getTime(),
        );
      });

      it('ignores a termEndDate a caller tries to smuggle in', async () => {
        // Not in the DTO, so `class-validator`'s whitelist drops it — but the
        // service must not read it either, or a hand-rolled request could still
        // choose its own defaulting cliff.
        await service.create(
          {
            ...validDto({
              planStartDate: PLAN_START,
              installmentFrequency: 'MONTHLY',
            }),
            termEndDate: new Date('2030-01-01T00:00:00.000Z'),
          } as CreateEnrollmentInviteDto,
          OWNER,
        );

        expect(writtenTermEnd().toISOString().slice(0, 10)).toBe('2026-12-19');
      });
    });

    it('issues an invite and returns a one-time share link', async () => {
      prisma.enrollmentInvite.create.mockResolvedValue(storedInvite());

      const result = await service.create(validDto(), OWNER);

      expect(result.claimUrl).toMatch(
        /^https:\/\/app\.lopay\.test\/#\/claim-invite\?token=[A-Za-z0-9_-]+$/,
      );
      expect(result.invite.studentName).toBe('Ada Lovelace');
      // The message is the school's to paste, so it has to carry the link.
      expect(result.message).toContain(result.claimUrl);
      // And nothing here addresses a channel: delivery is the school's own, and
      // a deep link that looked like delivery-to-a-number implied a guarantee
      // this system does not make. See `buildShare`.
      expect(result).not.toHaveProperty('whatsappUrl');
    });

    it('takes the fee from the published ClassFee, never from the request', async () => {
      prisma.enrollmentInvite.create.mockResolvedValue(storedInvite());

      await service.create(validDto(), OWNER);

      expect(prisma.classFee.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { schoolId: 'school-1', className: 'Basic 1', isActive: true },
        }),
      );
      const written = prisma.enrollmentInvite.create.mock.calls[0][0].data;
      expect(written.totalSchoolFee).toBe(10_000_000);
      expect(written.amountAlreadyPaid).toBe(4_000_000);
    });

    it('stores the phone blind index, and the number for the school to check', async () => {
      prisma.enrollmentInvite.create.mockResolvedValue(storedInvite());

      await service.create(validDto(), OWNER);

      const written = prisma.enrollmentInvite.create.mock.calls[0][0].data;
      expect(written.parentPhoneHash).toBe(PARENT_PHONE_HASH);
      expect(written.phoneNumber).toBe('+2348012345678');
    });

    it('persists only the digest of the token, never the token', async () => {
      prisma.enrollmentInvite.create.mockResolvedValue(storedInvite());

      const result = await service.create(validDto(), OWNER);

      const written = prisma.enrollmentInvite.create.mock.calls[0][0].data;
      const rawToken = parseClaimUrlToken(result.claimUrl)!;
      expect(written.tokenHash).toBe(hashInviteToken(rawToken));
      expect(written.tokenHash).not.toContain(rawToken);
    });

    it('keeps the raw token out of the audit trail', async () => {
      prisma.enrollmentInvite.create.mockResolvedValue(storedInvite());

      const result = await service.create(validDto(), OWNER);
      const rawToken = parseClaimUrlToken(result.claimUrl)!;

      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(rawToken);
    });

    it('keeps the parent phone out of the audit trail, hash included', async () => {
      // AuditLog is read by admins across every school and has no PII
      // encryption of its own. The blind index is not a redaction — it is a
      // stable, deterministic identifier for the number, so writing it here
      // would let anyone with log access join a parent's activity across every
      // school they appear in. That is why `invite-view.ts` will not ship it to
      // a browser and why better-auth marks `User.phoneHash` `returned: false`.
      // `entityId` still resolves to the invite for anyone with a reason to look.
      prisma.enrollmentInvite.create.mockResolvedValue(storedInvite());

      await service.create(validDto(), OWNER);

      const entry = audit.record.mock.calls[0][0];
      expect(entry.action).toBe(AuditAction.ENROLLMENT_INVITE_CREATED);

      const serialised = JSON.stringify(entry);
      expect(serialised).not.toContain('2348012345678');
      expect(serialised).not.toContain(PARENT_PHONE_HASH);
      expect(entry.entityId).toBe('invite-1');
    });

    it.each([
      ['a parent', { userId: 'p', role: UserRole.PARENT } as AuthUser],
      ['an admin', { userId: 'a', role: UserRole.SUPER_ADMIN } as AuthUser],
      [
        'an owner with no school',
        {
          userId: 'o',
          role: UserRole.SCHOOL_OWNER,
          schoolId: null,
        } as AuthUser,
      ],
    ])('refuses %s', async (_label, actor) => {
      await expect(service.create(validDto(), actor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.enrollmentInvite.create).not.toHaveBeenCalled();
    });

    it('refuses to act on a school the caller does not own', async () => {
      prisma.school.findFirst.mockResolvedValue(null);
      await expect(service.create(validDto(), OWNER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects an unusable phone number before minting anything', async () => {
      await expect(
        service.create(validDto({ parentPhone: '12345' }), OWNER),
      ).rejects.toThrow(/valid Nigerian phone number/);
      expect(prisma.enrollmentInvite.create).not.toHaveBeenCalled();
    });

    it('rejects a class with no published fee, naming the fix', async () => {
      prisma.classFee.findFirst.mockResolvedValue(null);
      await expect(service.create(validDto(), OWNER)).rejects.toThrow(
        /Set the class fee first/,
      );
    });

    it('rejects an amount larger than the class fee', async () => {
      await expect(
        service.create(validDto({ amountAlreadyPaid: 150_000 }), OWNER),
      ).rejects.toThrow(/cannot exceed/);
    });

    it('rejects a back-dated plan start', async () => {
      await expect(
        service.create(
          validDto({ planStartDate: new Date(Date.now() - 60 * DAY_MS) }),
          OWNER,
        ),
      ).rejects.toThrow(/cannot be in the past/);
    });

    it('refuses a second live invite for the same student', async () => {
      stubInviteLookup({ status: EnrollmentInviteStatus.PENDING });
      await expect(service.create(validDto(), OWNER)).rejects.toThrow(
        /already a live invite/,
      );
      expect(prisma.enrollmentInvite.create).not.toHaveBeenCalled();
    });

    /**
     * The migration window bounds ISSUING.
     *
     * Free migration is priced as one-time acquisition, redeemed when the family
     * enrols normally next term. Unbounded, a school could tell each term's
     * families to pay it directly and migrate them free for ever, and the
     * platform would never earn on that school at all.
     */
    describe('the migration window', () => {
      const closeWindow = (daysAgo = 1) =>
        prisma.school.findFirst.mockResolvedValue({
          id: 'school-1',
          name: 'Acme Academy',
          ownerId: 'owner-1',
          migrationDeadline: new Date(Date.now() - daysAgo * DAY_MS),
        });

      it('refuses a new invite once the window has closed', async () => {
        closeWindow();

        await expect(service.create(validDto(), OWNER)).rejects.toThrow(
          /migration window has closed/i,
        );
        expect(prisma.enrollmentInvite.create).not.toHaveBeenCalled();
      });

      it('tells the owner what to do instead, and that it can be extended', async () => {
        closeWindow();

        // A refusal that only says "no" turns into a support ticket. This one
        // has to name both the ordinary path and the exception.
        await expect(service.create(validDto(), OWNER)).rejects.toThrow(
          /enrol new students normally/i,
        );
        await expect(service.create(validDto(), OWNER)).rejects.toThrow(
          /contact Lopay/i,
        );
      });

      it('checks the window BEFORE anything else about the request', async () => {
        closeWindow();

        // A closed window makes every other field moot, and a school told
        // "that phone number is invalid" would fix the phone and be refused
        // again for the real reason.
        await expect(
          service.create(validDto({ parentPhone: 'nonsense' }), OWNER),
        ).rejects.toThrow(/migration window has closed/i);
      });

      it('still issues while the window is open', async () => {
        prisma.enrollmentInvite.create.mockResolvedValue(storedInvite());

        await expect(service.create(validDto(), OWNER)).resolves.toBeDefined();
      });

      it('does NOT block a parent claiming after the window closes', async () => {
        // The window governs issuing. An invite sent on day 58 and opened on
        // day 61 must still work — the invite has its own expiry, and stranding
        // a family because their school was slow to send is not the point.
        closeWindow();
        prisma.enrollmentInvite.findUnique.mockResolvedValue(storedInvite());

        await expect(service.claim(VALID_TOKEN, PARENT)).resolves.toMatchObject(
          { enrollmentId: 'enrollment-1' },
        );
      });

      it('reports the window alongside the list, so the UI can say it first', async () => {
        const page = await service.list(OWNER, {});

        expect(page.migrationWindow).toMatchObject({ isOpen: true });
        expect(page.migrationWindow.daysRemaining).toBeGreaterThan(0);
      });

      it('reports a closed window as closed, with zero days left', async () => {
        closeWindow(5);

        const page = await service.list(OWNER, {});
        expect(page.migrationWindow).toMatchObject({
          isOpen: false,
          daysRemaining: 0,
        });
      });
    });

    /**
     * One migration per student, ever — whatever class they were in.
     *
     * The slot rule is per class, because two live invites for one class are a
     * duplicate. className changes every term, so on its own it would let Ada be
     * migrated in Basic 1 this year and Basic 2 the next, free each time.
     */
    describe('one migration per student', () => {
      it('refuses a student already migrated in a DIFFERENT class', async () => {
        stubInviteLookup({
          className: 'Basic 1',
          status: EnrollmentInviteStatus.CLAIMED,
        });

        await expect(
          service.create(validDto({ className: 'Basic 2' }), OWNER),
        ).rejects.toThrow(/already been migrated onto Lopay \(in Basic 1\)/);
        expect(prisma.enrollmentInvite.create).not.toHaveBeenCalled();
      });

      it('names the ordinary path rather than just refusing', async () => {
        stubInviteLookup({
          className: 'Basic 1',
          status: EnrollmentInviteStatus.CLAIMED,
        });

        await expect(
          service.create(validDto({ className: 'Basic 2' }), OWNER),
        ).rejects.toThrow(/enrol them normally for this term/i);
      });

      it('ignores className when looking for a previous migration', async () => {
        stubInviteLookup(null);
        prisma.enrollmentInvite.create.mockResolvedValue(storedInvite());

        await service.create(validDto({ className: 'Basic 2' }), OWNER);

        const migratedCheck = prisma.enrollmentInvite.findFirst.mock.calls.find(
          ([arg]) => arg.where.status === EnrollmentInviteStatus.CLAIMED,
        );
        expect(migratedCheck).toBeDefined();
        expect(migratedCheck![0].where).not.toHaveProperty('className');
        // Case-folded, because retyping a name is how it gets entered.
        expect(migratedCheck![0].where.studentName).toMatchObject({
          mode: 'insensitive',
        });
      });
    });

    it('says so plainly when the student was already migrated', async () => {
      stubInviteLookup({
        className: 'Basic 1',
        status: EnrollmentInviteStatus.CLAIMED,
      });
      await expect(service.create(validDto(), OWNER)).rejects.toThrow(
        /already been migrated/,
      );
    });

    it('turns a lost race on the partial unique index into the same 400', async () => {
      // The pre-check above is advisory; this is the guarantee. Two owners
      // clicking at once must not produce a 500.
      const conflict = Object.assign(new Error('unique'), {
        code: 'P2002',
        clientVersion: '7',
        name: 'PrismaClientKnownRequestError',
      });
      Object.setPrototypeOf(
        conflict,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../generated/prisma/client').Prisma
          .PrismaClientKnownRequestError.prototype,
      );
      prisma.enrollmentInvite.create.mockRejectedValue(conflict);

      await expect(service.create(validDto(), OWNER)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses to mint a link when no web origin is configured', async () => {
      // A relative path in a WhatsApp message is worthless, and a school would
      // not find out until a parent complained. Fail loudly instead.
      config.get.mockReturnValue(undefined);
      prisma.enrollmentInvite.create.mockResolvedValue(storedInvite());

      await expect(service.create(validDto(), OWNER)).rejects.toThrow(
        /WEB_APP_URL/,
      );
    });

    it('fails on a missing origin BEFORE writing anything', async () => {
      // Ordering is the whole point. The origin comes from deployment config,
      // not the request, so it fails for every invite or none — and discovering
      // it after the insert would leave a PENDING row holding the student's
      // slot whose raw token (never stored, returned once) died with the stack
      // frame. The owner could neither resend it nor see why.
      config.get.mockReturnValue(undefined);

      await expect(service.create(validDto(), OWNER)).rejects.toThrow(
        /WEB_APP_URL/,
      );

      expect(prisma.enrollmentInvite.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('matches an existing live invite case-insensitively', async () => {
      // The partial unique index compares exactly, and a register typed twice
      // gives "Ada Lovelace" and "ada lovelace". Two live invites, two claims,
      // two Child rows. The service check is deliberately the wider of the two.
      stubInviteLookup({ status: EnrollmentInviteStatus.PENDING });

      await expect(service.create(validDto(), OWNER)).rejects.toThrow(
        /already a live invite/,
      );

      expect(prisma.enrollmentInvite.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            studentName: { equals: 'Ada Lovelace', mode: 'insensitive' },
            className: { equals: 'Basic 1', mode: 'insensitive' },
          }),
        }),
      );
    });
  });

  // ================================= preview ================================

  describe('preview', () => {
    it('renders the figures a parent is asked to confirm', async () => {
      prisma.enrollmentInvite.findUnique.mockResolvedValue(storedInvite());

      const view = await service.preview(VALID_TOKEN);

      expect(view).toMatchObject({
        studentName: 'Ada Lovelace',
        schoolName: 'Acme Academy',
        totalFee: 100_000,
        amountAlreadyPaid: 40_000,
        remainingBalance: 60_000,
        canClaim: true,
      });
    });

    it.each([
      ['a malformed token', 'nope'],
      ['an empty token', ''],
      ['a non-string token', undefined],
    ])('answers %s with the generic not-found', async (_label, token) => {
      await expect(service.preview(token)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.enrollmentInvite.findUnique).not.toHaveBeenCalled();
    });

    it('gives an unknown token the SAME message as an expired one', async () => {
      // Distinguishing them would tell a prober which guesses were once real.
      prisma.enrollmentInvite.findUnique.mockResolvedValue(null);
      const unknown = await service.preview(VALID_TOKEN).catch((e: Error) => e);

      prisma.enrollmentInvite.findUnique.mockResolvedValue(
        storedInvite({ expiresAt: new Date(Date.now() - 1) }),
      );
      const expired = await service
        .preview('y'.repeat(INVITE_TOKEN_LENGTH))
        .catch((e: Error) => e);

      expect((unknown as Error).message).toBe(
        'This invite link is not valid. It may have expired or already been used — ask your school to send a new one.',
      );
      // The expired one resolves rather than throwing, but reports canClaim:false
      // without revealing that it once existed beyond what the holder already knows.
      expect(expired).not.toBeInstanceOf(Error);
      expect((expired as { canClaim: boolean }).canClaim).toBe(false);
    });

    it('retires a lapsed invite opportunistically so the list self-heals', async () => {
      prisma.enrollmentInvite.findUnique.mockResolvedValue(
        storedInvite({ expiresAt: new Date(Date.now() - 1) }),
      );

      const view = await service.preview(VALID_TOKEN);

      expect(prisma.enrollmentInvite.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: EnrollmentInviteStatus.EXPIRED },
        }),
      );
      expect(view.status).toBe(EnrollmentInviteStatus.EXPIRED);
      expect(view.canClaim).toBe(false);
    });

    it('still answers when the opportunistic retire fails', async () => {
      prisma.enrollmentInvite.findUnique.mockResolvedValue(
        storedInvite({ expiresAt: new Date(Date.now() - 1) }),
      );
      prisma.enrollmentInvite.updateMany.mockRejectedValue(
        new Error('db down'),
      );

      await expect(service.preview(VALID_TOKEN)).resolves.toMatchObject({
        canClaim: false,
      });
    });
  });

  // ================================== claim =================================

  describe('claim', () => {
    beforeEach(() => {
      prisma.enrollmentInvite.findUnique.mockResolvedValue(storedInvite());
    });

    it('builds the plan and reports the resulting balance', async () => {
      const result = await service.claim(VALID_TOKEN, PARENT);

      expect(result).toMatchObject({
        enrollmentId: 'enrollment-1',
        studentName: 'Ada Lovelace',
        totalFee: 100_000,
        amountAlreadyPaid: 40_000,
        remainingBalance: 60_000,
        paymentStatus: PaymentStatus.ACTIVE,
      });
    });

    it('claims the invite conditionally, before touching the parent graph', async () => {
      await service.claim(VALID_TOKEN, PARENT);

      const where = prisma.enrollmentInvite.updateMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        id: 'invite-1',
        status: EnrollmentInviteStatus.PENDING,
      });
      // The window is re-checked in the write itself, so an invite that lapsed
      // between the read and the write still loses.
      expect(where.expiresAt).toHaveProperty('gt');
    });

    it('stops before creating anything when the conditional claim loses', async () => {
      prisma.enrollmentInvite.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.claim(VALID_TOKEN, PARENT)).rejects.toThrow(
        /no longer available/,
      );
      expect(prisma.parent.createMany).not.toHaveBeenCalled();
      expect(ledger.recordMigratedEnrollment).not.toHaveBeenCalled();
    });

    it('delegates every money write to the ledger, inside the transaction', async () => {
      await service.claim(VALID_TOKEN, PARENT);

      expect(ledger.recordMigratedEnrollment).toHaveBeenCalledTimes(1);
      const [client] = ledger.recordMigratedEnrollment.mock.calls[0];
      expect(client).toBe(tx);
    });

    it('emits realtime events only AFTER the transaction resolves', async () => {
      const order: string[] = [];
      prisma.$transaction.mockImplementation(
        async (fn: (c: unknown) => unknown) => {
          const out = await (fn as (c: unknown) => Promise<unknown>)(tx);
          order.push('commit');
          return out;
        },
      );
      ledger.announceMigratedEnrollment.mockImplementation(() =>
        order.push('announce'),
      );

      await service.claim(VALID_TOKEN, PARENT);

      expect(order).toEqual(['commit', 'announce']);
    });

    it('reuses an existing child rather than failing on the unique constraint', async () => {
      // The ordinary overlap: the family self-enrolled before the invite
      // arrived, or a sibling is already on Lopay.
      prisma.child.findFirstOrThrow.mockResolvedValue({ id: 'existing-child' });

      await service.claim(VALID_TOKEN, PARENT);

      expect(ledger.recordMigratedEnrollment.mock.calls[0][1].childId).toBe(
        'existing-child',
      );
    });

    it('resolves the child with a statement that cannot raise a conflict', async () => {
      // The load-bearing detail. A `create` that raises P2002 aborts the
      // enclosing PostgreSQL transaction, and Prisma sets no per-statement
      // SAVEPOINT — so catching it and re-reading, which is what
      // `EnrollmentService.resolveEnrollmentTarget` does OUTSIDE a transaction,
      // fails here with 25P02 and surfaces as a 500.
      //
      // `createMany` + `skipDuplicates` is the only Prisma call that emits
      // `INSERT … ON CONFLICT DO NOTHING`; `upsert` issues a SELECT then an
      // INSERT and so races just as badly. The follow-up read returns whichever
      // row won, which is all the caller wanted.
      await service.claim(VALID_TOKEN, PARENT);

      expect(prisma.child.createMany).toHaveBeenCalledWith({
        data: [
          {
            parentId: 'parent-row-1',
            fullName: 'Ada Lovelace',
            className: 'Basic 1',
          },
        ],
        skipDuplicates: true,
      });
      // Neither of the two patterns that can raise inside a transaction.
      expect(prisma.child.create).toBeUndefined();
      expect(prisma.child.upsert).toBeUndefined();
    });

    it('turns a unique violation that escapes the transaction into a retryable 400', async () => {
      // `resolveChild` cannot raise one, but the enrollment writes can, and
      // nothing inside the transaction can recover: the whole attempt rolls
      // back and the parent is told to try again — which works, because the
      // retry's reads see the row that beat it. What must NOT happen is a raw
      // 25P02 reaching them as a 500.
      const conflict = Object.assign(new Error('unique'), { code: 'P2002' });
      Object.setPrototypeOf(
        conflict,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../generated/prisma/client').Prisma
          .PrismaClientKnownRequestError.prototype,
      );
      prisma.child.createMany.mockRejectedValue(conflict);

      await expect(service.claim(VALID_TOKEN, PARENT)).rejects.toThrow(
        /Please try again/,
      );
    });

    it('does not swallow a non-conflict failure inside the claim', async () => {
      prisma.child.createMany.mockRejectedValue(new Error('connection lost'));

      await expect(service.claim(VALID_TOKEN, PARENT)).rejects.toThrow(
        'connection lost',
      );
    });

    /**
     * Holding the link is the whole of the authorisation.
     *
     * The phone match used to refuse here. It was removed because it proved
     * almost nothing — Lopay never verifies phone numbers, so a match only meant
     * someone had typed that number into a signup form — while reliably blocking
     * the people it was meant to serve: Google sign-ins carry no number at all,
     * and a single mistyped digit on the school's side made the wrong number the
     * ONLY one that could claim, locking the real parent out for good.
     *
     * The comparison survives as a signal the school is shown. See `release`
     * for what they do when it looks wrong.
     */
    it('lets a claimant with a different phone through, and records the mismatch', async () => {
      prisma.user.findUnique.mockResolvedValue({ phoneHash: 'someone-else' });

      await expect(service.claim(VALID_TOKEN, PARENT)).resolves.toMatchObject({
        enrollmentId: 'enrollment-1',
      });

      const [{ data }] = prisma.enrollmentInvite.updateMany.mock.calls.at(-1)!;
      expect(data.claimantPhoneMatched).toBe(false);
    });

    it('lets a claimant with NO phone through, and records that too', async () => {
      // The Google sign-in path: `signup-guard.ts` makes the number optional, so
      // an account without one is ordinary. "Nothing to compare" is a fact worth
      // showing the school and is not grounds to refuse anyone.
      prisma.user.findUnique.mockResolvedValue({ phoneHash: null });

      await expect(service.claim(VALID_TOKEN, PARENT)).resolves.toBeDefined();

      const [{ data }] = prisma.enrollmentInvite.updateMany.mock.calls.at(-1)!;
      expect(data.claimantPhoneMatched).toBe(false);
    });

    it('records a match when the number IS the one the school addressed', async () => {
      await service.claim(VALID_TOKEN, PARENT);

      const [{ data }] = prisma.enrollmentInvite.updateMany.mock.calls.at(-1)!;
      expect(data.claimantPhoneMatched).toBe(true);
    });

    it('warns the school, by name, when the claimant is not who they addressed', async () => {
      // The school's first and best chance to notice a link went astray. A
      // notification saying only "claimed by their parent" is uncheckable.
      prisma.user.findUnique.mockResolvedValue({ phoneHash: 'someone-else' });

      await service.claim(VALID_TOKEN, PARENT);

      const warning = notifications.create.mock.calls
        .map(
          ([payload]: [{ title: string; message: string; link: string }]) =>
            payload,
        )
        .find((payload) => /check this one/i.test(payload.title));
      expect(warning).toBeDefined();
      expect(warning!.message).toMatch(/NOT the one you addressed/);
      // Straight to the list, which is where the undo lives.
      expect(warning!.link).toBe('/school/invites');
    });

    it('lets a school owner claim an invite for their own child elsewhere', async () => {
      // Authorisation keys on the phone, not on UserRole — the regression this
      // codebase already fixed once in EnrollmentService.
      const ownerAsParent: AuthUser = {
        userId: 'parent-1',
        role: UserRole.SCHOOL_OWNER,
        schoolId: 'another-school',
      };

      await expect(
        service.claim(VALID_TOKEN, ownerAsParent),
      ).resolves.toMatchObject({ enrollmentId: 'enrollment-1' });
    });

    it('refuses a lapsed invite', async () => {
      prisma.enrollmentInvite.findUnique.mockResolvedValue(
        storedInvite({ expiresAt: new Date(Date.now() - 1) }),
      );
      prisma.enrollmentInvite.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.claim(VALID_TOKEN, PARENT)).rejects.toThrow(
        /no longer available/,
      );
    });

    it('does not fail a committed claim when the school notification fails', async () => {
      notifications.create.mockRejectedValue(new Error('fcm down'));

      await expect(service.claim(VALID_TOKEN, PARENT)).resolves.toMatchObject({
        enrollmentId: 'enrollment-1',
      });
    });

    it('links the school owner to a route that actually exists', async () => {
      // `/school/students` was the original target and there is no such route;
      // the web app has no catch-all either, so the owner tapped the push and
      // got a blank screen. Every link in a notification has to resolve.
      await service.claim(VALID_TOKEN, PARENT);

      const link = notifications.create.mock.calls[0][0].link;
      expect(link).toBe('/school-owner-dashboard');
    });

    it('tells the school owner their invite was claimed', async () => {
      await service.claim(VALID_TOKEN, PARENT);

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'owner-1',
          title: 'Migration invite claimed',
        }),
      );
    });

    it('refuses to enrol into a school that has left the platform', async () => {
      // The invite's foreign key guarantees the school row exists, so existence
      // is not the check — `deletedAt` is. A plan created here would have no
      // owner to confirm payments on it.
      prisma.school.findFirst.mockResolvedValue(null);

      await expect(service.claim(VALID_TOKEN, PARENT)).rejects.toThrow(
        /no longer active/,
      );
      expect(prisma.enrollmentInvite.updateMany).not.toHaveBeenCalled();
      expect(ledger.recordMigratedEnrollment).not.toHaveBeenCalled();
    });
  });

  // ================================= dispute ================================

  describe('dispute', () => {
    beforeEach(() => {
      prisma.enrollmentInvite.findUnique.mockResolvedValue(storedInvite());
    });

    it('moves the invite out of claimable circulation and records why', async () => {
      const result = await service.dispute(
        VALID_TOKEN,
        PARENT,
        'I paid ₦35,000',
      );

      expect(result.status).toBe(EnrollmentInviteStatus.DISPUTED);
      const [{ where, data }] =
        prisma.enrollmentInvite.updateMany.mock.calls.at(-1)!;
      expect(where).toMatchObject({
        id: 'invite-1',
        status: EnrollmentInviteStatus.PENDING,
      });
      expect(data).toMatchObject({
        status: EnrollmentInviteStatus.DISPUTED,
        disputeReason: 'I paid ₦35,000',
      });
      // The clock is part of the CONDITION, not merely checked upstream — see
      // the test below for why that distinction is load-bearing.
      expect(where.expiresAt).toHaveProperty('gt');
    });

    /**
     * The guard has to be evaluated by the database, not inferred from
     * `findByToken`'s opportunistic retirement.
     *
     * That retirement is best-effort and its failure is swallowed, so a blip
     * leaves the row PENDING while the invite object this method was handed
     * reports EXPIRED. `claim` has always carried `expiresAt` in its own
     * conditional write; this one did not, and the asymmetry is the bug.
     */
    it('cannot dispute a lapsed invite whose retirement write failed', async () => {
      const lapsed = storedInvite({ expiresAt: new Date(Date.now() - 60_000) });
      prisma.enrollmentInvite.findUnique.mockResolvedValue(lapsed);

      // The `where` has to be evaluated rather than asserted on, because the
      // whole point is what the DATABASE would do with it: a mock that returns
      // a fixed count proves nothing about a clause it never reads.
      let call = 0;
      prisma.enrollmentInvite.updateMany.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) => {
          call += 1;
          // Call 1 is findByToken's opportunistic retirement. Failing it is the
          // premise: the row stays PENDING while the object handed to `dispute`
          // says EXPIRED, which is the only state this guard defends.
          if (call === 1) return Promise.reject(new Error('db blip'));

          const clock = where.expiresAt as { gt: Date } | undefined;
          const matches =
            where.status === lapsed.status &&
            // Absent clause → Postgres matches on status alone, which is the
            // bug. Present clause → the lapsed row cannot satisfy it.
            (!clock || lapsed.expiresAt.getTime() > clock.gt.getTime());
          return Promise.resolve({ count: matches ? 1 : 0 });
        },
      );

      await expect(
        service.dispute(VALID_TOKEN, PARENT, 'I paid ₦35,000'),
      ).rejects.toThrow(/no longer awaiting your confirmation/);
    });

    it('actually tells the school, rather than only storing the complaint', async () => {
      await service.dispute(VALID_TOKEN, PARENT, 'I paid ₦35,000');

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'owner-1',
          title: 'Parent disputed a migration invite',
          message: expect.stringContaining('I paid ₦35,000'),
        }),
      );
    });

    it('audits the dispute with the parent as actor', async () => {
      await service.dispute(VALID_TOKEN, PARENT, 'wrong');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ENROLLMENT_INVITE_DISPUTED,
          actor: { userId: 'parent-1', role: UserRole.PARENT },
          reason: 'wrong',
        }),
      );
    });

    it('lets anyone holding the link dispute, phone match or not', async () => {
      // Disputing only contests a figure and creates nothing — gating it behind
      // an unverifiable phone would silence the person best placed to notice the
      // school typed the wrong number.
      prisma.user.findUnique.mockResolvedValue({ phoneHash: 'other' });

      await expect(
        service.dispute(VALID_TOKEN, PARENT, 'wrong'),
      ).resolves.toMatchObject({ status: EnrollmentInviteStatus.DISPUTED });
    });

    it('refuses to dispute an invite that is no longer pending', async () => {
      prisma.enrollmentInvite.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.dispute(VALID_TOKEN, PARENT, 'wrong'),
      ).rejects.toThrow(/no longer awaiting/);
    });
  });

  // ================================= revoke =================================

  describe('revoke', () => {
    it('cancels a live invite and audits it', async () => {
      prisma.enrollmentInvite.findFirst.mockResolvedValue(storedInvite());

      const result = await service.revoke('invite-1', OWNER, 'wrong number');

      expect(result.status).toBe(EnrollmentInviteStatus.REVOKED);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ENROLLMENT_INVITE_REVOKED,
          reason: 'wrong number',
        }),
      );
    });

    it('scopes the lookup to the caller’s own school', async () => {
      prisma.enrollmentInvite.findFirst.mockResolvedValue(null);

      await expect(
        service.revoke('invite-1', OWNER, undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.enrollmentInvite.findFirst).toHaveBeenCalledWith({
        where: { id: 'invite-1', schoolId: 'school-1' },
      });
    });

    it('points a school at the correction path when the invite is already claimed', async () => {
      prisma.enrollmentInvite.findFirst.mockResolvedValue(
        storedInvite({ status: EnrollmentInviteStatus.CLAIMED }),
      );
      prisma.enrollmentInvite.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.revoke('invite-1', OWNER)).rejects.toThrow(
        /Correct the amount on the plan/,
      );
    });

    it('refuses a non-owner', async () => {
      await expect(service.revoke('invite-1', PARENT)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ================================== amend =================================

  describe('amend', () => {
    it('delegates the money to the ledger in kobo', async () => {
      prisma.enrollmentInvite.findFirst.mockResolvedValue(
        storedInvite({
          status: EnrollmentInviteStatus.CLAIMED,
          enrollment: { id: 'enrollment-1' },
        }),
      );

      await service.amend('invite-1', { amountAlreadyPaid: 35_000 }, OWNER);

      expect(ledger.amendMigratedPayment).toHaveBeenCalledWith(
        'enrollment-1',
        3_500_000,
        'school-1',
        { userId: 'owner-1', role: UserRole.SCHOOL_OWNER },
        undefined,
      );
    });

    it('refuses when the invite has not been claimed yet', async () => {
      prisma.enrollmentInvite.findFirst.mockResolvedValue(
        storedInvite({ enrollment: null }),
      );

      await expect(
        service.amend('invite-1', { amountAlreadyPaid: 1 }, OWNER),
      ).rejects.toThrow(/no plan to correct/);
      expect(ledger.amendMigratedPayment).not.toHaveBeenCalled();
    });

    it('refuses a non-owner', async () => {
      await expect(
        service.amend('invite-1', { amountAlreadyPaid: 1 }, PARENT),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ================================== list ==================================

  /**
   * Removing a plan the wrong person claimed.
   *
   * The counterpart to claiming on nothing but the link: an authorisation model
   * that invites this mistake is only honest if the mistake can be undone. Before
   * this existed the wrong claim was permanent — token spent, student's slot held
   * by a CLAIMED row, a fabricated family on the roster for good.
   */
  describe('release', () => {
    const claimed = () =>
      storedInvite({
        status: EnrollmentInviteStatus.CLAIMED,
        claimedByUserId: 'parent-1',
        enrollment: { id: 'enrollment-1', childId: 'child-1' },
      });

    beforeEach(() => {
      prisma.enrollmentInvite.findFirst.mockResolvedValue(claimed());
    });

    it('deletes the plan through the LEDGER, never directly', async () => {
      // ADR 0004: the ledger owns every money write, and deleting payment rows
      // is one. A service reaching past it would put money state in two places.
      await service.release('invite-1', OWNER, 'wrong parent');

      expect(ledger.releaseMigratedEnrollment).toHaveBeenCalledTimes(1);
      const [client, args] = ledger.releaseMigratedEnrollment.mock.calls[0];
      expect(client).toBe(tx);
      expect(args).toMatchObject({
        enrollmentId: 'enrollment-1',
        childId: 'child-1',
        inviteId: 'invite-1',
        schoolId: 'school-1',
        reason: 'wrong parent',
      });
    });

    it('cancels the invite in the SAME transaction as the deletion', async () => {
      // A released plan with a still-CLAIMED invite is unusable in the other
      // direction: the slot stays held and no corrected invite can be issued.
      await service.release('invite-1', OWNER);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const [{ where, data }] =
        prisma.enrollmentInvite.updateMany.mock.calls.at(-1)!;
      expect(where).toMatchObject({
        id: 'invite-1',
        schoolId: 'school-1',
        status: EnrollmentInviteStatus.CLAIMED,
      });
      expect(data.status).toBe(EnrollmentInviteStatus.REVOKED);
      expect(data.revokedByUserId).toBe(OWNER.userId);
    });

    it('stops before deleting anything when the conditional write loses', async () => {
      prisma.enrollmentInvite.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.release('invite-1', OWNER)).rejects.toThrow(
        /already changed by someone else/,
      );
      expect(ledger.releaseMigratedEnrollment).not.toHaveBeenCalled();
    });

    it('tells the claimant their plan was removed, and why', async () => {
      // A plan vanishing from your account without explanation is worse than the
      // wrong claim was.
      await service.release('invite-1', OWNER, 'sent to the wrong number');

      const [payload] = notifications.create.mock.calls.at(-1)!;
      expect(payload.userId).toBe('parent-1');
      expect(payload.message).toMatch(/sent to the wrong number/);
    });

    it('refuses an invite that was never claimed', async () => {
      prisma.enrollmentInvite.findFirst.mockResolvedValue(
        storedInvite({ enrollment: null }),
      );

      await expect(service.release('invite-1', OWNER)).rejects.toThrow(
        /Cancel it instead/,
      );
      expect(ledger.releaseMigratedEnrollment).not.toHaveBeenCalled();
    });

    it('refuses an invite belonging to another school', async () => {
      prisma.enrollmentInvite.findFirst.mockResolvedValue(null);

      await expect(service.release('invite-1', OWNER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refreshes every dashboard that counted the plan', async () => {
      // The roster, the student count and the collections all move, on the
      // school's screen and the admin's.
      await service.release('invite-1', OWNER);

      expect(events.emitEnrollmentsChanged).toHaveBeenCalledWith(
        expect.objectContaining({ schoolId: 'school-1', notifyAdmins: true }),
      );
      expect(events.emitPaymentsChanged).toHaveBeenCalled();
    });

    it('does not undo a committed release because the notification failed', async () => {
      notifications.create.mockRejectedValueOnce(new Error('fcm down'));

      await expect(service.release('invite-1', OWNER)).resolves.toMatchObject({
        status: EnrollmentInviteStatus.REVOKED,
      });
    });
  });

  describe('list', () => {
    it('returns the standard paginated envelope, newest first', async () => {
      prisma.enrollmentInvite.findMany.mockResolvedValue([storedInvite()]);
      prisma.enrollmentInvite.count.mockResolvedValue(1);

      const page = await service.list(OWNER, {});

      expect(page).toMatchObject({ total: 1, page: 1, totalPages: 1 });
      expect(page.items[0].studentName).toBe('Ada Lovelace');
      expect(prisma.enrollmentInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });

    it('clamps an over-large page size rather than returning the table', async () => {
      await service.list(OWNER, { limit: 10_000 });
      expect(prisma.enrollmentInvite.findMany.mock.calls[0][0].take).toBe(200);
    });

    it('scopes every query to the caller’s school', async () => {
      await service.list(OWNER, { status: EnrollmentInviteStatus.PENDING });

      expect(prisma.enrollmentInvite.findMany.mock.calls[0][0].where).toEqual({
        schoolId: 'school-1',
        status: EnrollmentInviteStatus.PENDING,
      });
    });

    it('refuses a non-owner', async () => {
      await expect(service.list(PARENT, {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ============================== expireStale ===============================

  describe('expireStale', () => {
    it('retires only lapsed pending and disputed invites', async () => {
      prisma.enrollmentInvite.updateMany.mockResolvedValue({ count: 3 });
      const now = new Date();

      await expect(service.expireStale(now)).resolves.toBe(3);

      expect(prisma.enrollmentInvite.updateMany).toHaveBeenCalledWith({
        where: {
          status: {
            in: [
              EnrollmentInviteStatus.PENDING,
              EnrollmentInviteStatus.DISPUTED,
            ],
          },
          expiresAt: { lte: now },
        },
        data: { status: EnrollmentInviteStatus.EXPIRED },
      });
    });

    it('never touches a claimed invite', async () => {
      await service.expireStale();
      const statuses =
        prisma.enrollmentInvite.updateMany.mock.calls[0][0].where.status.in;
      expect(statuses).not.toContain(EnrollmentInviteStatus.CLAIMED);
    });
  });

  /**
   * The ownership rule, swept across EVERY owner endpoint at once.
   *
   * A per-method assertion is not enough here, because the failure mode is a
   * method that forgets the rule rather than one that gets it wrong — which is
   * exactly what happened in the first draft: `create` re-read the school and
   * checked `ownerId`, with a comment explaining the threat, while `list`,
   * `revoke` and `amend` trusted the session's `schoolId` alone.
   *
   * Driving all four off one table means the next method added to this service
   * has to be added here too, and a method that skips `assertOwnsSchool` fails
   * the moment it is listed.
   */
  describe('school ownership', () => {
    const CALLS: [string, () => Promise<unknown>][] = [
      ['create', () => service.create(validDto(), OWNER)],
      ['list', () => service.list(OWNER, {})],
      ['revoke', () => service.revoke('invite-1', OWNER)],
      [
        'amend',
        () => service.amend('invite-1', { amountAlreadyPaid: 100 }, OWNER),
      ],
    ];

    it.each(CALLS)(
      '%s refuses a school the caller no longer owns',
      async (_name, call) => {
        // The session still carries `schoolId` — this is precisely the case a
        // session-only check cannot see, because ownership moved underneath a
        // token that is still valid.
        prisma.school.findFirst.mockResolvedValue(null);

        await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it.each(CALLS)(
      '%s proves ownership against the database',
      async (_name, call) => {
        await call().catch(() => undefined);

        expect(prisma.school.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              id: 'school-1',
              ownerId: OWNER.userId,
              // A soft-deleted school must not still be issuing invites into
              // itself, or correcting money on plans inside it. `claim` has always
              // checked this; these four did not.
              deletedAt: null,
            }),
          }),
        );
      },
    );

    it.each(CALLS)(
      '%s refuses a parent holding a session with no school',
      async (_name, call) => {
        const parentActor = {
          userId: 'parent-1',
          role: UserRole.PARENT,
          schoolId: null,
        } as AuthUser;
        const parentCalls: Record<string, () => Promise<unknown>> = {
          create: () => service.create(validDto(), parentActor),
          list: () => service.list(parentActor, {}),
          revoke: () => service.revoke('invite-1', parentActor),
          amend: () =>
            service.amend('invite-1', { amountAlreadyPaid: 100 }, parentActor),
        };
        void call;

        await expect(parentCalls[_name]()).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        // Refused on the role, before any query — the cheap check stays first.
        expect(prisma.school.findFirst).not.toHaveBeenCalled();
      },
    );
  });
});
