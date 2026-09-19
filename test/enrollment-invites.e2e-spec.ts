/**
 * Real-database integration tests for enrollment invites.
 *
 * The unit suites mock Prisma, which means they cannot prove the things this
 * feature actually depends on: that the migration applies, that the partial
 * unique index really does allow a re-issue after a revoke but not a second live
 * invite, that the CHECK constraints reject impossible money, and that a claim
 * leaves a plan whose derived schedule and arrears read correctly. All of that
 * is asserted here against the real Postgres.
 *
 * Requires the local Docker DB (see LOCAL_DEV.md): postgres on :5434 with
 * migrations applied. Everything touching the database is real; only the
 * outward boundaries (notifications, realtime, metrics) are stubbed.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { AuditService } from '../src/audit/audit.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { EventsGateway } from '../src/events/events.gateway';
import { MetricsService } from '../src/common/observability/metrics.service';
import { EnrollmentInvitesService } from '../src/enrollment-invites/enrollment-invites.service';
import { parseClaimUrlToken } from '../src/enrollment-invites/claim-url';
import { phoneBlindIndex } from '../src/common/phone';
import { initEncryptionKey } from '../src/common/encryption';
import {
  derivePlanProgress,
  installmentCountFor,
  installmentDueDate,
} from '../src/common/installment-schedule';
import { computeArrears } from '../src/common/arrears';
import {
  AuditAction,
  EnrollmentInviteStatus,
  PaymentReceiver,
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  UserRole,
} from '../src/generated/prisma/client';
import { MOVED_THROUGH_LOPAY } from '../src/common/migrated-plan';
import { plainToInstance } from 'class-transformer';
import { CreateEnrollmentInviteDto } from '../src/enrollment-invites/dto/create-enrollment-invite.dto';
import type { AuthUser } from '../src/common/types/auth-user';

const DAY_MS = 24 * 60 * 60 * 1000;
const PARENT_PHONE = '08031234567';
const OTHER_PHONE = '08039999999';

describe('Enrollment invites (real DB)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let invites: EnrollmentInvitesService;
  let notifications: { create: jest.Mock };

  let schoolId: string;
  let ownerUserId: string;
  /**
   * Fixtures a single test creates for itself, torn down by `afterEach`.
   *
   * The suite shares one database and one `beforeEach` identity, so anything a
   * test creates outside that set has to be tracked or it leaks and breaks the
   * NEXT test's setup on a unique column — which is a failure that points at
   * the wrong test entirely.
   */
  let extraSchoolIds: string[];
  let extraUserIds: string[];
  let parentUserId: string;
  let owner: AuthUser;
  let parent: AuthUser;

  const futureDate = (days: number) => new Date(Date.now() + days * DAY_MS);

  beforeAll(async () => {
    // The real ConfigService is used — stubbing it would starve PrismaService of
    // DATABASE_URL. The invite link needs an origin, so provide one through the
    // same channel a deployment would.
    process.env.WEB_APP_URL = 'https://app.lopay.test';

    // Turn PII encryption ON for this suite. `PrismaService` only installs the
    // encryption extension when a key is configured (it is optional outside
    // production), so without this the suite would silently exercise the
    // plaintext path and prove nothing about how the phone number is stored.
    // Must run BEFORE the module is compiled, because the decision is made in
    // the PrismaService constructor.
    initEncryptionKey('11'.repeat(32));

    notifications = { create: jest.fn().mockResolvedValue({}) };

    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        PrismaService,
        LedgerService,
        AuditService,
        EnrollmentInvitesService,
        { provide: NotificationsService, useValue: notifications },
        {
          provide: EventsGateway,
          useValue: {
            emitPaymentsChanged: jest.fn(),
            emitEnrollmentsChanged: jest.fn(),
            pushNotification: jest.fn(),
          },
        },
        {
          provide: MetricsService,
          useValue: {
            recordPaymentOutcome: jest.fn(),
            setStalledConfirmations: jest.fn(),
            recordPaystackFeeDelta: jest.fn(),
            recordReconcileConflict: jest.fn(),
          },
        },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    invites = moduleRef.get(EnrollmentInvitesService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    notifications.create.mockClear();
    extraSchoolIds = [];
    extraUserIds = [];

    const tag = randomUUID().slice(0, 8);
    ownerUserId = randomUUID();
    parentUserId = randomUUID();
    schoolId = randomUUID();

    await prisma.user.create({
      data: {
        id: ownerUserId,
        email: `owner_${tag}@itest.local`,
        role: UserRole.SCHOOL_OWNER,
        fullName: 'Invite Owner',
      },
    });
    await prisma.user.create({
      data: {
        id: parentUserId,
        email: `parent_${tag}@itest.local`,
        role: UserRole.PARENT,
        fullName: 'Invite Parent',
        phoneNumber: PARENT_PHONE,
        phoneHash: phoneBlindIndex(PARENT_PHONE),
      },
    });
    await prisma.school.create({
      data: {
        id: schoolId,
        name: `ITEST Invites ${tag}`,
        email: `school_${tag}@itest.local`,
        phone: '08011111111',
        address: '1 Test Road',
        ownerId: ownerUserId,
        bankName: 'Test Bank',
        accountName: 'Test School',
        accountNumber: '0123456789',
      },
    });
    await prisma.classFee.create({
      data: {
        schoolId,
        className: 'Basic 1',
        feeAmount: 10_000_000, // ₦100,000
        isActive: true,
      },
    });

    owner = { userId: ownerUserId, role: UserRole.SCHOOL_OWNER, schoolId };
    parent = { userId: parentUserId, role: UserRole.PARENT };
  });

  afterEach(async () => {
    const schoolIds = [schoolId, ...extraSchoolIds];
    const userIds = [ownerUserId, parentUserId, ...extraUserIds];

    await prisma.auditLog.deleteMany({
      where: { schoolId: { in: schoolIds } },
    });
    await prisma.payment.deleteMany({ where: { schoolId: { in: schoolIds } } });
    await prisma.childEnrollment.deleteMany({
      where: { schoolId: { in: schoolIds } },
    });
    await prisma.child.deleteMany({
      where: { parent: { userId: { in: userIds } } },
    });
    await prisma.enrollmentInvite.deleteMany({
      where: { schoolId: { in: schoolIds } },
    });
    await prisma.classFee.deleteMany({
      where: { schoolId: { in: schoolIds } },
    });
    await prisma.parent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.school.deleteMany({ where: { id: { in: schoolIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  /**
   * Build the DTO the way Nest's ValidationPipe does, then call the service.
   *
   * `plainToInstance` rather than a bare object literal on purpose: the
   * `@Transform`s on `CreateEnrollmentInviteDto` (trim, collapse internal
   * whitespace, uppercase the cadence) are part of what reaches the database,
   * and a suite that skips them is asserting against a call shape the
   * controller never actually produces.
   */
  const buildDto = (overrides: Record<string, unknown> = {}) =>
    plainToInstance(CreateEnrollmentInviteDto, {
      studentName: 'Ada Lovelace',
      className: 'Basic 1',
      amountAlreadyPaid: 40_000,
      parentPhone: PARENT_PHONE,
      installmentFrequency: 'MONTHLY',
      planStartDate: new Date(),
      // No termEndDate: the service derives it from the start date and the
      // cadence. See `derivePlanEnd` for why it is not an input.
      ...overrides,
    });

  const createInvite = (
    overrides: Record<string, unknown> = {},
    actor: AuthUser = owner,
  ) => invites.create(buildDto(overrides), actor);

  // Parsed with the same function the web client uses, so a change to the link
  // format breaks here rather than silently only in a browser.
  const tokenFrom = (claimUrl: string) => parseClaimUrlToken(claimUrl)!;

  // ============================ the happy path =============================

  it('carries a parent from invite to an active plan with the right balance', async () => {
    const created = await createInvite();
    const token = tokenFrom(created.claimUrl);

    const preview = await invites.preview(token);
    expect(preview).toMatchObject({
      studentName: 'Ada Lovelace',
      totalFee: 100_000,
      amountAlreadyPaid: 40_000,
      remainingBalance: 60_000,
      canClaim: true,
    });

    const claimed = await invites.claim(token, parent);
    expect(claimed).toMatchObject({
      remainingBalance: 60_000,
      paymentStatus: PaymentStatus.ACTIVE,
    });

    const enrollment = await prisma.childEnrollment.findUniqueOrThrow({
      where: { id: claimed.enrollmentId },
      include: { payments: true, child: true },
    });

    expect(enrollment.totalSchoolFee).toBe(10_000_000);
    expect(enrollment.firstPaymentPaid).toBe(4_000_000);
    expect(enrollment.remainingBalance).toBe(6_000_000);
    expect(enrollment.platformFee).toBe(0);
    expect(enrollment.child.fullName).toBe('Ada Lovelace');

    const payment = enrollment.payments[0];
    expect(payment.paymentType).toBe(PaymentType.MIGRATED_PAYMENT);
    expect(payment.isConfirmed).toBe(true);
    expect(payment.platformAmount).toBe(0);
  });

  it('leaves the plan reading correctly to the schedule and arrears code', async () => {
    // The reason the money is modelled as a deposit rather than installments.
    const created = await createInvite();
    const claimed = await invites.claim(tokenFrom(created.claimUrl), parent);

    const enrollment = await prisma.childEnrollment.findUniqueOrThrow({
      where: { id: claimed.enrollmentId },
      include: { payments: true },
    });
    const installmentsPaidKobo = enrollment.payments
      .filter((p) => p.paymentType === PaymentType.INSTALLMENT && p.isConfirmed)
      .reduce((sum, p) => sum + p.amountPaid, 0);

    // ₦60,000 over three monthly slots — NOT ₦100,000, which is what a plan
    // would show if the prior payment had been recorded as installments.
    const progress = derivePlanProgress({
      remainingBalance: enrollment.remainingBalance,
      installmentsPaidKobo,
      installmentFrequency: enrollment.installmentFrequency,
    });
    expect(progress.planStartBalance).toBe(6_000_000);
    expect(progress.nextInstallmentAmount).toBe(2_000_000);

    // And it is not born overdue.
    const arrears = computeArrears(
      {
        remainingBalance: enrollment.remainingBalance,
        installmentFrequency: 'MONTHLY',
        termStartDate: enrollment.termStartDate,
        termEndDate: enrollment.termEndDate,
        installmentsPaidKobo,
      },
      new Date(),
    );
    expect(arrears.overdueAmount).toBe(0);
    expect(arrears.daysOverdue).toBe(0);
  });

  it.each(['MONTHLY', 'WEEKLY'] as const)(
    'ends a %s plan exactly when its last instalment falls due',
    async (installmentFrequency) => {
      /**
       * `termEndDate` is a cliff, not a label. `DefaulterDetectionService`
       * selects on `termEndDate < now` and `computeArrears` calls the entire
       * remaining balance overdue past it, so the plan has to end exactly when
       * the last instalment does. Asserted here against the real row because
       * the consequence of drifting either way is a family wrongly defaulted or
       * wrongly exempt — neither of which a mocked Prisma would show.
       */
      const created = await createInvite({ installmentFrequency });
      const claimed = await invites.claim(tokenFrom(created.claimUrl), parent);

      const enrollment = await prisma.childEnrollment.findUniqueOrThrow({
        where: { id: claimed.enrollmentId },
      });

      const lastDue = installmentDueDate(
        enrollment.termStartDate,
        installmentFrequency,
        installmentCountFor(installmentFrequency),
      );
      expect(enrollment.termEndDate.getTime()).toBe(lastDue.getTime());

      // The defaulter sweep's own predicate: not yet past, so not defaultable.
      expect(enrollment.termEndDate.getTime()).toBeGreaterThan(Date.now());

      // And arrears does not treat the term as expired, which would call the
      // whole balance overdue on day one.
      const arrears = computeArrears(
        {
          remainingBalance: enrollment.remainingBalance,
          installmentFrequency,
          termStartDate: enrollment.termStartDate,
          termEndDate: enrollment.termEndDate,
          installmentsPaidKobo: 0,
        },
        new Date(),
      );
      expect(arrears.termExpired).toBe(false);
      expect(arrears.overdueAmount).toBe(0);
    },
  );

  it('completes a plan for a parent who had already paid in full', async () => {
    const created = await createInvite({ amountAlreadyPaid: 100_000 });
    const claimed = await invites.claim(tokenFrom(created.claimUrl), parent);

    expect(claimed.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(claimed.remainingBalance).toBe(0);
  });

  it('writes an audit row for the issue and the claim', async () => {
    const created = await createInvite();
    await invites.claim(tokenFrom(created.claimUrl), parent);

    const actions = (
      await prisma.auditLog.findMany({ where: { schoolId } })
    ).map((row) => row.action);

    expect(actions).toEqual(
      expect.arrayContaining([
        AuditAction.ENROLLMENT_INVITE_CREATED,
        AuditAction.ENROLLMENT_INVITE_CLAIMED,
      ]),
    );
  });

  // ============================ database rules =============================

  it('stores only the token digest, and encrypts the phone number at rest', async () => {
    const created = await createInvite();
    const token = tokenFrom(created.claimUrl);

    const row = await prisma.enrollmentInvite.findFirstOrThrow({
      where: { schoolId },
    });
    expect(row.tokenHash).not.toContain(token);

    // Read around Prisma's decryption extension to see what is really on disk.
    const [raw] = await prisma.$queryRaw<
      { phoneNumber: string; parentPhoneHash: string }[]
    >`SELECT "phoneNumber", "parentPhoneHash" FROM "EnrollmentInvite" WHERE "id" = ${row.id}`;
    expect(raw.phoneNumber).not.toContain('8031234567');
    expect(raw.parentPhoneHash).toBe(phoneBlindIndex(PARENT_PHONE));
    // Prisma still hands the plaintext back to the application.
    expect(row.phoneNumber).toBe('+2348031234567');
  });

  it('refuses a second live invite for the same student', async () => {
    await createInvite();
    await expect(createInvite()).rejects.toThrow(/already a live invite/);
  });

  it('allows a re-issue once the first invite is revoked', async () => {
    // The whole reason the unique index is partial: correcting a wrong phone
    // number is the single most likely thing a school needs to do.
    const first = await createInvite();
    await invites.revoke(first.invite.id, owner, 'wrong number');

    const second = await createInvite({ parentPhone: OTHER_PHONE });
    expect(second.invite.id).not.toBe(first.invite.id);
  });

  it('rejects an amount above the class fee at the database level too', async () => {
    // The service checks this, but the CHECK constraint is what holds if any
    // future caller bypasses the service.
    await expect(
      prisma.enrollmentInvite.create({
        data: {
          schoolId,
          createdByUserId: ownerUserId,
          studentName: 'Bypass',
          className: 'Basic 1',
          totalSchoolFee: 10_000_000,
          amountAlreadyPaid: 99_999_999,
          phoneNumber: '+2348031234567',
          parentPhoneHash: 'x'.repeat(64),
          installmentFrequency: 'MONTHLY',
          planStartDate: new Date(),
          termEndDate: futureDate(90),
          tokenHash: randomUUID(),
          expiresAt: futureDate(14),
        },
      }),
    ).rejects.toThrow(/EnrollmentInvite_paid_within_fee/);
  });

  it('rejects an inverted plan window at the database level', async () => {
    await expect(
      prisma.enrollmentInvite.create({
        data: {
          schoolId,
          createdByUserId: ownerUserId,
          studentName: 'Inverted',
          className: 'Basic 1',
          totalSchoolFee: 10_000_000,
          amountAlreadyPaid: 0,
          phoneNumber: '+2348031234567',
          parentPhoneHash: 'y'.repeat(64),
          installmentFrequency: 'MONTHLY',
          planStartDate: futureDate(90),
          termEndDate: new Date(),
          tokenHash: randomUUID(),
          expiresAt: futureDate(14),
        },
      }),
    ).rejects.toThrow(/EnrollmentInvite_term_after_start/);
  });

  // ============================== concurrency ==============================

  it('lets exactly one of two simultaneous claims win', async () => {
    const created = await createInvite();
    const token = tokenFrom(created.claimUrl);

    const results = await Promise.allSettled([
      invites.claim(token, parent),
      invites.claim(token, parent),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    // And exactly one plan exists — not two, and not zero.
    const enrollments = await prisma.childEnrollment.findMany({
      where: { schoolId },
    });
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0].enrollmentInviteId).toBe(created.invite.id);
  });

  it('cannot be claimed twice in sequence either', async () => {
    const created = await createInvite();
    const token = tokenFrom(created.claimUrl);

    await invites.claim(token, parent);
    await expect(invites.claim(token, parent)).rejects.toThrow();
  });

  it('resolves the Child row without ever raising a unique violation', async () => {
    // Two invites for the SAME student name and class at two different schools,
    // claimed by the same parent at the same instant. Both claims are legitimate
    // and both need a `Child` row for `(parentId, 'Race Twin', 'Basic 1')` — the
    // one path in a claim where two transactions genuinely contend for the same
    // unique key.
    //
    // The failure this guards against is not "one claim loses". It is that a
    // unique violation inside a PostgreSQL transaction aborts the whole
    // transaction, and Prisma sets no per-statement SAVEPOINT, so a
    // catch-and-re-read recovery cannot run — it dies with `25P02` and reaches
    // the parent as a 500. `createMany({ skipDuplicates: true })` emits
    // `INSERT … ON CONFLICT DO NOTHING`, which the database resolves itself.
    // A second owner, because `School.ownerId` is unique — one school each.
    const secondTag = randomUUID().slice(0, 8);
    const secondOwnerId = randomUUID();
    await prisma.user.create({
      data: {
        id: secondOwnerId,
        email: `owner2_${secondTag}@itest.local`,
        role: UserRole.SCHOOL_OWNER,
        fullName: 'Second Owner',
      },
    });
    extraUserIds.push(secondOwnerId);
    const second = await prisma.school.create({
      data: {
        name: `ITEST Second ${secondTag}`,
        email: `second_${secondTag}@itest.local`,
        phone: '08022222222',
        address: 'Elsewhere',
        ownerId: secondOwnerId,
        bankName: 'Test Bank',
        accountName: 'Second School',
        accountNumber: '0123456789',
      },
    });
    await prisma.classFee.create({
      data: {
        schoolId: second.id,
        className: 'Basic 1',
        feeAmount: 10_000_000,
      },
    });
    extraSchoolIds.push(second.id);
    const secondOwner: AuthUser = {
      ...owner,
      userId: secondOwnerId,
      schoolId: second.id,
    };

    const here = await createInvite({ studentName: 'Race Twin' });
    const there = await createInvite({ studentName: 'Race Twin' }, secondOwner);

    const outcomes = await Promise.allSettled([
      invites.claim(tokenFrom(here.claimUrl), parent),
      invites.claim(tokenFrom(there.claimUrl), parent),
    ]);

    // Whatever the interleaving, no claim may fail with an aborted-transaction
    // error. `ChildEnrollment.childId` is unique, so at most one plan attaches
    // to the shared child; the other is refused with a reason a human can read.
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        const message = (outcome.reason as Error).message;
        expect(message).not.toMatch(/25P02|current transaction is aborted/i);
        expect(message).toMatch(
          /already has a payment plan|Please try again|no longer available/i,
        );
      }
    }
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);

    // Exactly one Child row, not two and not zero.
    const parentRow = await prisma.parent.findUniqueOrThrow({
      where: { userId: parentUserId },
    });
    const children = await prisma.child.findMany({
      where: { parentId: parentRow.id, fullName: 'Race Twin' },
    });
    expect(children).toHaveLength(1);
  });

  it('refuses a second live invite that differs only in letter case', async () => {
    // The partial unique index compares exactly, so it would allow this. The
    // service check is deliberately wider, because the input is a human typing
    // a child's name off a register twice and these are one child — two live
    // invites would mean two claims and two Child rows.
    await createInvite({ studentName: 'Ada Lovelace' });

    await expect(
      createInvite({ studentName: 'ada  LOVELACE' }),
    ).rejects.toThrow(/already a live invite/i);
  });

  it('stores the name as the school wrote it, with whitespace collapsed', async () => {
    // Case is matched loosely but never rewritten: a stored name should read
    // the way its school typed it. Whitespace is collapsed, because a stray
    // double space is not a different child.
    const created = await createInvite({ studentName: '  Grace   Hopper ' });

    const row = await prisma.enrollmentInvite.findUniqueOrThrow({
      where: { id: created.invite.id },
    });
    expect(row.studentName).toBe('Grace Hopper');
  });

  // =============================== rejections ==============================

  /**
   * The phone is a signal, not a gate — see `claimantPhoneMatches`.
   *
   * This used to assert a refusal. The refusal was removed because it proved
   * almost nothing (Lopay never verifies phone numbers) while reliably blocking
   * the right people — most sharply when the school mistyped a digit, which made
   * the wrong number the ONLY one that could claim.
   */
  it('still builds the plan when the claimant’s phone is not the one addressed', async () => {
    const created = await createInvite({ parentPhone: OTHER_PHONE });

    await expect(
      invites.claim(tokenFrom(created.claimUrl), parent),
    ).resolves.toMatchObject({ studentName: 'Ada Lovelace' });

    expect(await prisma.childEnrollment.count({ where: { schoolId } })).toBe(1);
    const row = await prisma.enrollmentInvite.findUniqueOrThrow({
      where: { id: created.invite.id },
    });
    expect(row.claimantPhoneMatched).toBe(false);
  });

  it('refuses an expired invite and retires it', async () => {
    const created = await createInvite();
    await prisma.enrollmentInvite.update({
      where: { id: created.invite.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(
      invites.claim(tokenFrom(created.claimUrl), parent),
    ).rejects.toThrow();

    const row = await prisma.enrollmentInvite.findUniqueOrThrow({
      where: { id: created.invite.id },
    });
    expect(row.status).toBe(EnrollmentInviteStatus.EXPIRED);
  });

  it('refuses to claim into a school that has left the platform', async () => {
    // The foreign key guarantees the school ROW exists, but a soft-deleted
    // school has no owner watching it — enrolling a family there would create a
    // plan nobody will ever confirm a payment on.
    const created = await createInvite();
    await prisma.school.update({
      where: { id: schoolId },
      data: { deletedAt: new Date() },
    });

    await expect(
      invites.claim(tokenFrom(created.claimUrl), parent),
    ).rejects.toThrow(/no longer active/);

    expect(await prisma.childEnrollment.count({ where: { schoolId } })).toBe(0);

    // Restore so the shared teardown can delete it.
    await prisma.school.update({
      where: { id: schoolId },
      data: { deletedAt: null },
    });
  });

  it('refuses a revoked invite', async () => {
    const created = await createInvite();
    await invites.revoke(created.invite.id, owner);

    await expect(
      invites.claim(tokenFrom(created.claimUrl), parent),
    ).rejects.toThrow();
  });

  it('reuses an existing child instead of creating a duplicate', async () => {
    // The realistic overlap: the family already enrolled this child themselves.
    const parentRow = await prisma.parent.create({
      data: { userId: parentUserId, phoneNumber: PARENT_PHONE },
    });
    await prisma.child.create({
      data: {
        parentId: parentRow.id,
        fullName: 'Ada Lovelace',
        className: 'Basic 1',
      },
    });

    const created = await createInvite();
    await invites.claim(tokenFrom(created.claimUrl), parent);

    const children = await prisma.child.findMany({
      where: { parentId: parentRow.id },
    });
    expect(children).toHaveLength(1);
  });

  it('refuses to migrate a child who already has a plan, with a usable message', async () => {
    const parentRow = await prisma.parent.create({
      data: { userId: parentUserId, phoneNumber: PARENT_PHONE },
    });
    const child = await prisma.child.create({
      data: {
        parentId: parentRow.id,
        fullName: 'Ada Lovelace',
        className: 'Basic 1',
      },
    });
    await prisma.childEnrollment.create({
      data: {
        childId: child.id,
        schoolId,
        className: 'Basic 1',
        totalSchoolFee: 10_000_000,
        platformFee: 250_000,
        schoolMinimumFee: 2_500_000,
        firstPaymentPaid: 2_500_000,
        remainingBalance: 7_500_000,
        paymentStatus: PaymentStatus.ACTIVE,
        installmentFrequency: 'MONTHLY',
        termStartDate: new Date(),
        termEndDate: futureDate(90),
      },
    });

    const created = await createInvite();
    await expect(
      invites.claim(tokenFrom(created.claimUrl), parent),
    ).rejects.toThrow(/already has a payment plan/);

    // The invite must not be left CLAIMED with no plan behind it.
    const row = await prisma.enrollmentInvite.findUniqueOrThrow({
      where: { id: created.invite.id },
    });
    expect(row.status).toBe(EnrollmentInviteStatus.PENDING);
  });

  // ============================ dispute & amend ============================

  it('takes a disputed invite out of circulation and keeps the reason', async () => {
    const created = await createInvite();
    const token = tokenFrom(created.claimUrl);

    await invites.dispute(token, parent, 'I paid ₦35,000');

    const row = await prisma.enrollmentInvite.findUniqueOrThrow({
      where: { id: created.invite.id },
    });
    expect(row.status).toBe(EnrollmentInviteStatus.DISPUTED);
    expect(row.disputeReason).toBe('I paid ₦35,000');

    await expect(invites.claim(token, parent)).rejects.toThrow();
  });

  it('lets a school correct the figure on a claimed plan and re-derives the balance', async () => {
    const created = await createInvite();
    const claimed = await invites.claim(tokenFrom(created.claimUrl), parent);

    const amended = await invites.amend(
      created.invite.id,
      { amountAlreadyPaid: 25_000, reason: 'bank statement' },
      owner,
    );

    expect(amended.remainingBalance).toBe(75_000);

    const enrollment = await prisma.childEnrollment.findUniqueOrThrow({
      where: { id: claimed.enrollmentId },
      include: { payments: true },
    });
    expect(enrollment.firstPaymentPaid).toBe(2_500_000);
    expect(enrollment.remainingBalance).toBe(7_500_000);
    expect(enrollment.payments[0].amountPaid).toBe(2_500_000);
  });

  /**
   * A next-term migration must not write a confirmed payment into the future.
   *
   * `validatePlanStart` permits a start date up to a year ahead so a school can
   * prepare early, which made this an ordinary path. The damage shows up on the
   * ADMIN dashboard rather than on the plan: `recentTransactions` orders by
   * `paymentDate desc` with no upper bound, so every such row outranks all
   * genuinely recent platform activity until that date arrives.
   */
  it('dates a next-term migration to the claim, not to the future start', async () => {
    const nextTerm = new Date(Date.now() + 60 * DAY_MS);
    const created = await createInvite({ planStartDate: nextTerm });

    const claimed = await invites.claim(tokenFrom(created.claimUrl), parent);

    const enrollment = await prisma.childEnrollment.findUniqueOrThrow({
      where: { id: claimed.enrollmentId },
      include: { payments: true },
    });

    // The money row is clamped…
    expect(enrollment.payments[0].paymentDate.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    // …while the plan itself still opens when the school said it would, so the
    // schedule and the defaulting cliff are untouched.
    expect(enrollment.termStartDate.getTime()).toBe(nextTerm.getTime());
  });

  /**
   * A correction restates a past figure; it does not assert the family is up to
   * date, and it must not silently say so.
   *
   * A migrated plan runs exactly the cadence's span, so reaching `termEndDate`
   * with a balance and being flipped to DEFAULTED is the ordinary end of an
   * unpaid plan. Re-deriving ACTIVE from the new balance cleared that — the
   * school's defaulted tile, the admin's defaulted count and the arrears
   * escalation all stopped seeing the family until the next sweep.
   */
  it('leaves a defaulted plan defaulted when a correction still leaves a balance', async () => {
    const created = await createInvite();
    const claimed = await invites.claim(tokenFrom(created.claimUrl), parent);

    // Exactly what DefaulterDetectionService does to a plan past its term.
    await prisma.childEnrollment.update({
      where: { id: claimed.enrollmentId },
      data: { paymentStatus: PaymentStatus.DEFAULTED },
    });

    await invites.amend(
      created.invite.id,
      { amountAlreadyPaid: 25_000 },
      owner,
    );

    const after = await prisma.childEnrollment.findUniqueOrThrow({
      where: { id: claimed.enrollmentId },
    });
    expect(after.paymentStatus).toBe(PaymentStatus.DEFAULTED);
    expect(after.remainingBalance).toBe(7_500_000);
  });

  it('still completes a defaulted plan when the correction clears the balance', async () => {
    const created = await createInvite();
    const claimed = await invites.claim(tokenFrom(created.claimUrl), parent);

    await prisma.childEnrollment.update({
      where: { id: claimed.enrollmentId },
      data: { paymentStatus: PaymentStatus.DEFAULTED },
    });

    await invites.amend(
      created.invite.id,
      { amountAlreadyPaid: 100_000 },
      owner,
    );

    const after = await prisma.childEnrollment.findUniqueOrThrow({
      where: { id: claimed.enrollmentId },
    });
    expect(after.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(after.remainingBalance).toBe(0);
  });

  it('restates the invite too, so the school list stops showing the old figure', async () => {
    // The invite row is the only place an owner reviews these numbers: the list
    // renders it and the amend form pre-fills it as "Currently recorded".
    // Leaving it at the original value made a successful correction look like
    // it had not applied — and a second attempt at the same figure was then
    // refused as "the same as the recorded one", compared against a number that
    // was no longer true.
    const created = await createInvite();
    await invites.claim(tokenFrom(created.claimUrl), parent);

    await invites.amend(
      created.invite.id,
      { amountAlreadyPaid: 25_000 },
      owner,
    );

    const [listed] = (await invites.list(owner, {})).items;
    expect(listed.amountAlreadyPaid).toBe(25_000);
    expect(listed.remainingBalance).toBe(75_000);

    // And a correction back to the original figure is accepted, because the
    // "no change" guard is now comparing against the truth.
    await expect(
      invites.amend(created.invite.id, { amountAlreadyPaid: 40_000 }, owner),
    ).resolves.toMatchObject({ amountAlreadyPaid: 40_000 });
  });

  it('keeps migrated money out of the collections figure, but on the plan', async () => {
    // A MIGRATED_PAYMENT is a real payment against a real plan — it reduces the
    // balance and belongs in the parent's history — but it is cash the school
    // banked before Lopay was involved. No rail carried it and `platformAmount`
    // is zero, so counting it as a collection would make the owner's "School
    // Collections" tile jump by months-old money the instant a parent claims.
    //
    // Split deliberately: `schools.service.coverage.spec.ts` pins the exact
    // `where` that `getDashboardStats` builds, and this proves that `where`
    // does the right thing against real rows. Instantiating SchoolsService here
    // would drag its whole dependency graph into a suite about invites.
    const created = await createInvite();
    const claimed = await invites.claim(tokenFrom(created.claimUrl), parent);

    // An ordinary installment, to prove the filter excludes migrated money
    // rather than simply excluding everything.
    await prisma.payment.create({
      data: {
        enrollmentId: claimed.enrollmentId,
        schoolId,
        amountPaid: 1_000_000,
        platformAmount: 0,
        schoolAmount: 1_000_000,
        receiver: PaymentReceiver.SCHOOL,
        paymentType: PaymentType.INSTALLMENT,
        status: PaymentTransactionStatus.SUCCESS,
        isConfirmed: true,
        paymentDate: new Date(),
      },
    });

    const collections = await prisma.payment.aggregate({
      where: {
        schoolId,
        isConfirmed: true,
        status: PaymentTransactionStatus.SUCCESS,
        ...MOVED_THROUGH_LOPAY,
      },
      _sum: { schoolAmount: true },
    });
    expect(collections._sum.schoolAmount).toBe(1_000_000);

    // Unfiltered, the migrated ₦40,000 is right there — this is an exclusion at
    // the aggregate, not a row that was never written.
    const everything = await prisma.payment.aggregate({
      where: { schoolId, isConfirmed: true },
      _sum: { schoolAmount: true },
    });
    expect(everything._sum.schoolAmount).toBe(5_000_000);

    // And the money is still credited to the plan, which is the whole point of
    // the feature. Both facts have to hold together.
    const enrollment = await prisma.childEnrollment.findUniqueOrThrow({
      where: { id: claimed.enrollmentId },
    });
    expect(enrollment.firstPaymentPaid).toBe(4_000_000);
  });

  it('completes the plan when a correction clears the balance', async () => {
    const created = await createInvite();
    await invites.claim(tokenFrom(created.claimUrl), parent);

    const amended = await invites.amend(
      created.invite.id,
      { amountAlreadyPaid: 100_000 },
      owner,
    );

    expect(amended.remainingBalance).toBe(0);
    expect(amended.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });

  it('refuses a correction that would leave the plan overpaid', async () => {
    const created = await createInvite();
    const claimed = await invites.claim(tokenFrom(created.claimUrl), parent);

    // The parent pays ₦50,000 of the remaining ₦60,000.
    await prisma.payment.create({
      data: {
        enrollmentId: claimed.enrollmentId,
        schoolId,
        amountPaid: 5_000_000,
        platformAmount: 0,
        schoolAmount: 5_000_000,
        receiver: 'SCHOOL',
        paymentType: PaymentType.INSTALLMENT,
        status: 'SUCCESS',
        isConfirmed: true,
      },
    });
    await prisma.childEnrollment.update({
      where: { id: claimed.enrollmentId },
      data: { remainingBalance: 1_000_000 },
    });

    // Correcting the migrated figure UP to ₦90,000 would total ₦140,000 against
    // a ₦100,000 fee.
    await expect(
      invites.amend(created.invite.id, { amountAlreadyPaid: 90_000 }, owner),
    ).rejects.toThrow(/overpaid/);
  });

  // ============================== tenancy ==================================

  // ========================= releasing a wrong claim ========================

  /**
   * Claiming needs only the link, so a link that reaches the wrong person is a
   * foreseeable outcome. These prove the undo actually leaves the database in a
   * state the school can work from — which is the whole point of it.
   */
  it('lets anyone holding the link claim, whatever number they signed up with', async () => {
    const created = await createInvite({ parentPhone: '08099999999' });

    // `parent` signed up with a completely different number.
    const claimed = await invites.claim(tokenFrom(created.claimUrl), parent);

    expect(claimed.enrollmentId).toBeTruthy();
    const row = await prisma.enrollmentInvite.findUniqueOrThrow({
      where: { id: created.invite.id },
    });
    // Allowed through, and the mismatch is recorded for the school to see.
    expect(row.status).toBe(EnrollmentInviteStatus.CLAIMED);
    expect(row.claimantPhoneMatched).toBe(false);
  });

  it('records a match when the claimant IS the number addressed', async () => {
    const created = await createInvite();
    await invites.claim(tokenFrom(created.claimUrl), parent);

    const row = await prisma.enrollmentInvite.findUniqueOrThrow({
      where: { id: created.invite.id },
    });
    expect(row.claimantPhoneMatched).toBe(true);
  });

  it('shows the school who claimed, and whether the number matched', async () => {
    const created = await createInvite({ parentPhone: '08099999999' });
    await invites.claim(tokenFrom(created.claimUrl), parent);

    const [listed] = (await invites.list(owner, {})).items;
    expect(listed.claimedByName).toBeTruthy();
    expect(listed.claimantPhoneMatched).toBe(false);
  });

  it('removes the plan, the payment and the child, and frees the student', async () => {
    const created = await createInvite();
    const claimed = await invites.claim(tokenFrom(created.claimUrl), parent);

    const enrollment = await prisma.childEnrollment.findUniqueOrThrow({
      where: { id: claimed.enrollmentId },
    });

    await invites.release(created.invite.id, owner, 'wrong parent');

    // Every row the claim created is gone…
    expect(
      await prisma.childEnrollment.findUnique({
        where: { id: claimed.enrollmentId },
      }),
    ).toBeNull();
    expect(
      await prisma.payment.count({
        where: { enrollmentId: claimed.enrollmentId },
      }),
    ).toBe(0);
    expect(
      await prisma.child.findUnique({ where: { id: enrollment.childId } }),
    ).toBeNull();

    // …the invite is dead rather than re-claimable (the token was spent)…
    const row = await prisma.enrollmentInvite.findUniqueOrThrow({
      where: { id: created.invite.id },
    });
    expect(row.status).toBe(EnrollmentInviteStatus.REVOKED);

    // …and the audit row is the only surviving record of the plan.
    const audited = await prisma.auditLog.findFirst({
      where: {
        action: AuditAction.ENROLLMENT_INVITE_RELEASED,
        entityId: created.invite.id,
      },
    });
    expect(audited).toBeTruthy();
    expect(audited!.before).toMatchObject({
      enrollmentId: claimed.enrollmentId,
      firstPaymentPaid: 4_000_000,
    });
  });

  it('frees the slot, so a corrected invite can be issued immediately', async () => {
    // The point of releasing: the school re-sends to the right person. A CLAIMED
    // row held the one-live-invite-per-student slot and blocked exactly this.
    const created = await createInvite();
    await invites.claim(tokenFrom(created.claimUrl), parent);
    await invites.release(created.invite.id, owner);

    await expect(createInvite()).resolves.toMatchObject({
      invite: { studentName: 'Ada Lovelace' },
    });
  });

  it('refuses to release once an instalment has actually been paid', async () => {
    const created = await createInvite();
    const claimed = await invites.claim(tokenFrom(created.claimUrl), parent);

    // Real money against the plan. Deleting it would destroy the only record of
    // a transfer that genuinely happened.
    await prisma.payment.create({
      data: {
        enrollmentId: claimed.enrollmentId,
        schoolId,
        amountPaid: 2_000_000,
        platformAmount: 0,
        schoolAmount: 2_000_000,
        receiver: PaymentReceiver.SCHOOL,
        paymentType: PaymentType.INSTALLMENT,
        status: PaymentTransactionStatus.SUCCESS,
        isConfirmed: true,
      },
    });

    await expect(invites.release(created.invite.id, owner)).rejects.toThrow(
      /refund/i,
    );

    // And nothing was half-deleted on the way to refusing.
    expect(
      await prisma.childEnrollment.findUnique({
        where: { id: claimed.enrollmentId },
      }),
    ).not.toBeNull();
    const row = await prisma.enrollmentInvite.findUniqueOrThrow({
      where: { id: created.invite.id },
    });
    expect(row.status).toBe(EnrollmentInviteStatus.CLAIMED);
  });

  it('hides one school’s invites from another', async () => {
    await createInvite();

    const otherOwnerId = randomUUID();
    const otherSchoolId = randomUUID();
    const tag = randomUUID().slice(0, 8);
    await prisma.user.create({
      data: {
        id: otherOwnerId,
        email: `other_${tag}@itest.local`,
        role: UserRole.SCHOOL_OWNER,
      },
    });
    await prisma.school.create({
      data: {
        id: otherSchoolId,
        name: `Other ${tag}`,
        email: `otherschool_${tag}@itest.local`,
        phone: '08022222222',
        address: '2 Test Road',
        ownerId: otherOwnerId,
        bankName: 'Test Bank',
        accountName: 'Other School',
        accountNumber: '9876543210',
      },
    });

    try {
      const page = await invites.list(
        {
          userId: otherOwnerId,
          role: UserRole.SCHOOL_OWNER,
          schoolId: otherSchoolId,
        },
        {},
      );
      expect(page.items).toHaveLength(0);
      expect(page.total).toBe(0);
    } finally {
      await prisma.school.deleteMany({ where: { id: otherSchoolId } });
      await prisma.user.deleteMany({ where: { id: otherOwnerId } });
    }
  });

  // ================================ sweep ==================================

  it('expires lapsed invites and leaves claimed ones alone', async () => {
    const lapsing = await createInvite({ studentName: 'Lapsing Student' });
    const claiming = await createInvite({ studentName: 'Ada Lovelace' });
    await invites.claim(tokenFrom(claiming.claimUrl), parent);

    await prisma.enrollmentInvite.update({
      where: { id: lapsing.invite.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    // A claimed invite past its window must survive the sweep.
    await prisma.enrollmentInvite.update({
      where: { id: claiming.invite.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await invites.expireStale(new Date());

    const rows = await prisma.enrollmentInvite.findMany({
      where: { schoolId },
    });
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(lapsing.invite.id)).toBe(EnrollmentInviteStatus.EXPIRED);
    expect(byId.get(claiming.invite.id)).toBe(EnrollmentInviteStatus.CLAIMED);
  });
});
