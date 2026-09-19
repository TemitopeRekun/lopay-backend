import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  EnrollmentInviteStatus,
  NotificationType,
  Prisma,
  UserRole,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { Money } from '../common/money';
import { canonicalizePhone, phoneBlindIndex } from '../common/phone';
import { errorMessage } from '../common/errors';
import { paginate, parsePagination } from '../common/pagination';
import { requireWebAppOrigin } from '../common/web-app-origin';
import type { AuthUser } from '../common/types/auth-user';
import { buildClaimUrl } from './claim-url';
import { hashInviteToken, mintInviteToken } from './invite-token';
import {
  EXPIRABLE_STATUSES,
  SLOT_HOLDING_STATUSES,
  derivePlanEnd,
  expiryFrom,
  hasExpired,
  validatePlanStart,
} from './invite-policy';
import {
  toParentInviteView,
  toSchoolInviteView,
  type SchoolInviteView,
} from './invite-view';
import type {
  AmendMigratedPaymentDto,
  ListEnrollmentInvitesDto,
} from './dto/claim-enrollment-invite.dto';
import type { CreateEnrollmentInviteDto } from './dto/create-enrollment-invite.dto';

/**
 * Onboarding parents who paid their school before the school adopted Lopay.
 *
 * ## The problem
 *
 * A school arriving on Lopay mid-term already has families part-way through
 * paying. Those parents have no account, and the money they paid exists only in
 * the school's own records. Enrolling them through the normal flow is impossible
 * — it starts with a Paystack deposit — and leaving them off means the school's
 * dashboard shows a fraction of its real book.
 *
 * ## The shape of the answer
 *
 * The school states the facts; the parent confirms them; only then does anything
 * become real.
 *
 *   1. The school creates an invite: which student, which class, how much has
 *      already been paid, and the WhatsApp number to send it to. A one-time
 *      token is minted and handed back inside a share link. Nothing has been
 *      enrolled and no money has been recorded.
 *   2. The parent opens the link and sees what the school claims, before signing
 *      in and before anything is committed. They confirm it or they dispute it.
 *   3. A confirmed claim builds the Parent/Child/Enrollment graph and records the
 *      prior payment through `LedgerService`, atomically.
 *
 * The middle step is not decoration. The already-paid figure is typed by hand
 * from a paper record and it *reduces what we can collect*, so the person with
 * the most incentive to notice an error — the parent who paid — gets to see it
 * before it becomes their balance.
 *
 * ## Authorisation
 *
 * Creating, listing, revoking, correcting and releasing are the school owner's,
 * scoped to their own school and proven against the database on every one of
 * them (`assertOwnsSchool`).
 *
 * Claiming and disputing require the raw token and nothing else. A phone match
 * was required once; it read as a second factor and was not one, because Lopay
 * verifies no phone number anywhere — see `claimantPhoneMatches` for the whole
 * argument, including why it refused more legitimate parents than impostors.
 *
 * The link is therefore a bearer credential, deliberately, and the design pays
 * for that honestly rather than pretending otherwise: the comparison is still
 * made and shown to the school, the claim notification names who claimed, and
 * `release` undoes a claim that reached the wrong person.
 *
 * Note what the claim is NOT gated on either: `UserRole`. A school owner may
 * have a child at a different school, and role-gating that person out of their
 * own family's plan is a bug this codebase has already fixed once, in
 * `EnrollmentService.submitInstallmentPayment`.
 */
@Injectable()
export class EnrollmentInvitesService {
  private readonly logger = new Logger(EnrollmentInvitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly events: EventsGateway,
    private readonly config: ConfigService,
  ) {}

  // ============================== school side ==============================

  /**
   * Issue an invite for one student.
   *
   * Everything that can be checked is checked before the token is minted, so a
   * rejected request never leaves a half-formed invite or burns a slot.
   */
  async create(dto: CreateEnrollmentInviteDto, actor: AuthUser) {
    const schoolId = await this.assertOwnsSchool(actor);
    const now = new Date();

    // Resolved FIRST, before the row exists, because this is the one input that
    // comes from deployment config rather than the request and the one failure
    // that cannot be retried into. `requireWebAppOrigin` throws when neither
    // WEB_APP_URL nor a usable CORS_ORIGINS entry is set; discovering that after
    // the insert would commit a PENDING invite holding the student's slot whose
    // raw token — the only copy, never stored — died with the stack frame. The
    // owner could not resend it and could not see why. Failing here costs the
    // school a 500 and nothing else.
    const origin = this.webAppOrigin();

    const parentPhone = canonicalizePhone(dto.parentPhone);
    const parentPhoneHash = phoneBlindIndex(dto.parentPhone);
    if (!parentPhone || !parentPhoneHash) {
      throw new BadRequestException(
        'Enter a valid Nigerian phone number, e.g. 08012345678',
      );
    }

    const startError = validatePlanStart(dto.planStartDate, now);
    if (startError) throw new BadRequestException(startError);

    // The plan's end is DERIVED, never supplied. `termEndDate` is the cliff that
    // `DefaulterDetectionService` and `computeArrears` both read, and the
    // cadence's instalment count is fixed, so a hand-typed date is wrong in one
    // of two directions: too early defaults the family before their first
    // instalment is due, too late exempts them from defaulting altogether. See
    // `derivePlanEnd`.
    const termEndDate = derivePlanEnd(
      dto.planStartDate,
      dto.installmentFrequency,
    );

    // The fee is the school's PUBLISHED one, never a number typed per-invite.
    const classFee = await this.prisma.classFee.findFirst({
      where: { schoolId, className: dto.className, isActive: true },
      select: { feeAmount: true },
    });
    if (!classFee) {
      throw new BadRequestException(
        `No active fee is published for "${dto.className}". Set the class fee first, then create the invite.`,
      );
    }

    const totalSchoolFee = classFee.feeAmount;
    const amountAlreadyPaid = Money.fromNaira(dto.amountAlreadyPaid).toKobo();
    if (amountAlreadyPaid > totalSchoolFee) {
      throw new BadRequestException(
        `Amount already paid cannot exceed the ${dto.className} fee of ${Money.fromKobo(totalSchoolFee).formatNaira()}`,
      );
    }

    // Checked here for a usable message; guaranteed by the partial unique index
    // `EnrollmentInvite_live_student_key`, which is what actually holds under a
    // race. The catch below turns the losing side of that race into this same
    // message rather than a 500.
    await this.assertNoLiveInvite(schoolId, dto.studentName, dto.className);

    const token = mintInviteToken();
    const expiresAt = expiryFrom(now, dto.expiresInDays);

    let invite;
    try {
      invite = await this.prisma.enrollmentInvite.create({
        data: {
          schoolId,
          createdByUserId: actor.userId,
          studentName: dto.studentName,
          className: dto.className,
          totalSchoolFee,
          amountAlreadyPaid,
          // Encrypted at rest by the field-name-keyed PII extension.
          phoneNumber: parentPhone,
          parentPhoneHash,
          installmentFrequency: dto.installmentFrequency,
          planStartDate: dto.planStartDate,
          termEndDate,
          tokenHash: token.tokenHash,
          expiresAt,
        },
      });
    } catch (error) {
      if (EnrollmentInvitesService.isUniqueViolation(error)) {
        throw new BadRequestException(
          `There is already a live invite for ${dto.studentName} in ${dto.className}. Cancel it before issuing another.`,
        );
      }
      throw error;
    }

    await this.audit.record({
      action: AuditAction.ENROLLMENT_INVITE_CREATED,
      entityType: 'EnrollmentInvite',
      entityId: invite.id,
      actor: { userId: actor.userId, role: actor.role },
      schoolId,
      metadata: {
        studentName: invite.studentName,
        className: invite.className,
        totalSchoolFee,
        amountAlreadyPaid,
        expiresAt,
        // Neither the phone number NOR its blind index is recorded here. The
        // audit log is read by admins across every school and has no PII
        // encryption of its own, and `parentPhoneHash` is not a redaction — it
        // is a stable, deterministic identifier for that number, so writing it
        // here would let anyone with log access join a parent's activity across
        // every school they appear in. That is exactly why `invite-view.ts`
        // refuses to ship it to a browser and why better-auth marks
        // `User.phoneHash` `returned: false`. `entityId` already resolves to the
        // invite, which holds the number encrypted at rest, so an investigator
        // with a reason to look has a route and a casual reader does not.
      },
    });

    return {
      invite: toSchoolInviteView(invite, now),
      ...EnrollmentInvitesService.buildShare(origin, token.token, invite),
    };
  }

  /** The school owner's invites, newest first, filtered by status. */
  async list(
    actor: AuthUser,
    filters: ListEnrollmentInvitesDto,
  ): Promise<ReturnType<typeof paginate<SchoolInviteView>>> {
    const schoolId = await this.assertOwnsSchool(actor);
    const { page, limit, skip } = parsePagination(filters.page, filters.limit, {
      defaultLimit: 25,
    });
    const now = new Date();

    const where: Prisma.EnrollmentInviteWhereInput = {
      schoolId,
      ...(filters.status ? { status: filters.status } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.enrollmentInvite.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
        include: {
          enrollment: { select: { id: true } },
          // Named so the school can tell whether the link reached the family
          // they meant. `phoneHash` is NOT selected — the match was decided and
          // stored at claim time, so the hash never has to leave the database.
          claimedBy: { select: { fullName: true, name: true } },
        },
      }),
      this.prisma.enrollmentInvite.count({ where }),
    ]);

    return paginate(
      rows.map((row) => toSchoolInviteView(row, now)),
      total,
      page,
      limit,
    );
  }

  /**
   * Cancel a live invite.
   *
   * The correction path for the mistakes a school actually makes — a digit wrong
   * in the phone number, the wrong amount, the wrong class. Revoking frees the
   * student's slot (the partial unique index excludes REVOKED) so a corrected
   * invite can be issued immediately.
   *
   * A CLAIMED invite cannot be revoked: there is a live plan behind it and a
   * family paying against it. Correcting that is `amend`.
   */
  async revoke(inviteId: string, actor: AuthUser, reason?: string) {
    const schoolId = await this.assertOwnsSchool(actor);

    const invite = await this.prisma.enrollmentInvite.findFirst({
      where: { id: inviteId, schoolId },
    });
    if (!invite) throw new NotFoundException('Invite not found');

    // Conditional write: two concurrent revokes, or a revoke racing a claim,
    // resolve to exactly one winner rather than both "succeeding".
    const revoked = await this.prisma.enrollmentInvite.updateMany({
      where: {
        id: inviteId,
        schoolId,
        status: {
          in: [EnrollmentInviteStatus.PENDING, EnrollmentInviteStatus.DISPUTED],
        },
      },
      data: {
        status: EnrollmentInviteStatus.REVOKED,
        revokedAt: new Date(),
        revokedByUserId: actor.userId,
      },
    });

    if (revoked.count === 0) {
      throw new BadRequestException(
        invite.status === EnrollmentInviteStatus.CLAIMED
          ? 'This invite has already been claimed. Correct the amount on the plan instead of cancelling the invite.'
          : `This invite is ${invite.status.toLowerCase()} and cannot be cancelled.`,
      );
    }

    await this.audit.record({
      action: AuditAction.ENROLLMENT_INVITE_REVOKED,
      entityType: 'EnrollmentInvite',
      entityId: inviteId,
      actor: { userId: actor.userId, role: actor.role },
      schoolId,
      reason,
      before: { status: invite.status },
      after: { status: EnrollmentInviteStatus.REVOKED },
    });

    return { id: inviteId, status: EnrollmentInviteStatus.REVOKED };
  }

  /**
   * Correct the already-paid figure on a plan that came from an invite —
   * including one the parent disputed after claiming.
   *
   * Delegates the money entirely to `LedgerService.amendMigratedPayment`; this
   * method's job is to resolve the invite to its enrollment and prove the caller
   * owns the school.
   */
  async amend(inviteId: string, dto: AmendMigratedPaymentDto, actor: AuthUser) {
    const schoolId = await this.assertOwnsSchool(actor);

    const invite = await this.prisma.enrollmentInvite.findFirst({
      where: { id: inviteId, schoolId },
      include: { enrollment: { select: { id: true } } },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (!invite.enrollment) {
      throw new BadRequestException(
        'This invite has not been claimed yet, so there is no plan to correct. Cancel it and issue a new one.',
      );
    }

    return this.ledger.amendMigratedPayment(
      invite.enrollment.id,
      Money.fromNaira(dto.amountAlreadyPaid).toKobo(),
      schoolId,
      { userId: actor.userId, role: actor.role },
      dto.reason,
    );
  }

  /**
   * Remove a plan that the wrong person claimed, and free the student to be
   * re-invited.
   *
   * ## Why this exists
   *
   * Because claiming requires only the link. That is deliberate — the link is
   * issued and sent inside a conversation the school and parent have already
   * had — but it means a link that is forwarded, or sent to a mistyped number,
   * produces a real plan under the wrong account. Before this, that was
   * permanent: the token was single-use and never recoverable, the CLAIMED row
   * held the student's slot so no corrected invite could be issued, and a
   * family that does not exist sat on the school's roster for good.
   *
   * A feature whose authorisation is "whoever holds the link" is only honest if
   * the mistake it invites can be undone. This is that undo.
   *
   * ## What it is not
   *
   * Not `amend`, which restates a wrong FIGURE on a plan belonging to the right
   * family. Not `revoke`, which cancels a link nobody has used yet. This is for
   * a plan that should never have been created at all, and it is the only one of
   * the three that destroys rows — see `LedgerService.releaseMigratedEnrollment`
   * for why deleting is the right shape here and soft-voiding is not.
   *
   * The invite lands in REVOKED rather than back in PENDING: the raw token was
   * shown once and is unrecoverable, so there is nothing to return it to. The
   * school issues a fresh invite, which REVOKED makes possible by releasing the
   * one-live-invite-per-student slot.
   */
  async release(inviteId: string, actor: AuthUser, reason?: string) {
    const schoolId = await this.assertOwnsSchool(actor);

    const invite = await this.prisma.enrollmentInvite.findFirst({
      where: { id: inviteId, schoolId },
      include: { enrollment: { select: { id: true, childId: true } } },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (!invite.enrollment) {
      throw new BadRequestException(
        invite.status === EnrollmentInviteStatus.CLAIMED
          ? 'This invite has no plan behind it, so there is nothing to remove.'
          : 'This invite has not been claimed, so there is no plan to remove. Cancel it instead.',
      );
    }

    // Read BEFORE the deletes: after them, the claimant is no longer reachable
    // through the enrollment, and they are the person who most needs telling.
    const claimantUserId = invite.claimedByUserId;
    const enrollmentId = invite.enrollment.id;

    await this.prisma.$transaction(async (tx) => {
      // Conditional, for the same reason `claim`'s write is: two owners tapping
      // at once, or a release racing an amend, must resolve to one winner rather
      // than both deleting.
      const released = await tx.enrollmentInvite.updateMany({
        where: {
          id: inviteId,
          schoolId,
          status: EnrollmentInviteStatus.CLAIMED,
        },
        data: {
          status: EnrollmentInviteStatus.REVOKED,
          revokedAt: new Date(),
          revokedByUserId: actor.userId,
        },
      });
      if (released.count === 0) {
        throw new BadRequestException(
          'This invite was already changed by someone else — reload and try again.',
        );
      }

      await this.ledger.releaseMigratedEnrollment(tx, {
        enrollmentId,
        childId: invite.enrollment!.childId,
        inviteId,
        schoolId,
        actor: { userId: actor.userId, role: actor.role },
        reason,
      });
    });

    // Committed. The claimant must be told: a plan disappeared from their
    // account, and finding that out by noticing is worse than being told.
    // Best-effort, like every other post-commit effect here — the plan is
    // already gone and re-raising would invite the school to retry a delete that
    // has happened.
    if (claimantUserId) {
      await this.notifyUser(claimantUserId, {
        title: 'A payment plan was removed',
        message:
          `${invite.studentName}'s school has removed the ${invite.className} plan that was added to your account. ` +
          (reason
            ? `Their reason: “${reason}”. `
            : 'This usually means the invite link reached the wrong person. ') +
          'If you believe this is a mistake, contact the school.',
        type: NotificationType.ALERT,
        link: '/dashboard',
      });
    }

    // Every dashboard that counted this plan is now wrong, including the
    // admin's — the roster, the student count and the collections all move.
    this.events.emitEnrollmentsChanged({
      parentUserId: claimantUserId ?? undefined,
      schoolId,
      notifyAdmins: true,
    });
    this.events.emitPaymentsChanged({
      parentUserId: claimantUserId ?? undefined,
      schoolId,
      notifyAdmins: true,
    });

    return { id: inviteId, status: EnrollmentInviteStatus.REVOKED };
  }

  // ============================== parent side ==============================

  /**
   * What the claim screen shows before the visitor has signed in.
   *
   * Unauthenticated by necessity — a parent follows the link before they have an
   * account — and therefore gated only by the token. See `ParentInviteView` for
   * what that deliberately does and does not expose.
   */
  async preview(rawToken: unknown) {
    const { invite } = await this.findByToken(rawToken);
    return toParentInviteView(invite);
  }

  /**
   * Turn a confirmed invite into a real enrollment.
   *
   * Everything below happens in one transaction, because a half-applied claim is
   * unrecoverable: the token is single-use, so an invite left CLAIMED with no
   * plan behind it cannot be claimed again and cannot be re-sent.
   */
  async claim(rawToken: unknown, user: AuthUser) {
    const { invite, tokenHash } = await this.findByToken(rawToken);

    // Compared, recorded, and never used to refuse — see `claimantPhoneMatches`.
    // Resolved before the transaction so a claim never waits on it, and so the
    // value written is the one that was true when the claim was made.
    const phoneMatched = await this.claimantPhoneMatches(invite, user.userId);

    // `deletedAt` is checked, not just existence. The foreign key guarantees the
    // row is there, but a school can be soft-deleted while its invites are still
    // live, and enrolling a family into a school that has left the platform
    // creates a plan nobody will ever collect or confirm.
    const school = await this.prisma.school.findFirst({
      where: { id: invite.schoolId, deletedAt: null },
      select: { name: true, ownerId: true },
    });
    if (!school) {
      throw new BadRequestException(
        'This school is no longer active on Lopay, so the invite cannot be claimed.',
      );
    }

    const result = await this.runClaimTransaction(async (tx) => {
      // Claim the invite FIRST, conditionally. Winning this write is what earns
      // the right to build the enrollment; a second concurrent claim finds
      // count === 0 and stops before touching the Parent/Child graph.
      const claimed = await tx.enrollmentInvite.updateMany({
        where: {
          id: invite.id,
          tokenHash,
          status: EnrollmentInviteStatus.PENDING,
          expiresAt: { gt: new Date() },
        },
        data: {
          status: EnrollmentInviteStatus.CLAIMED,
          claimedByUserId: user.userId,
          claimedAt: new Date(),
          claimantPhoneMatched: phoneMatched,
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException(
          'This invite is no longer available. It may have been claimed, cancelled or expired.',
        );
      }

      const parent = await this.resolveParent(tx, user.userId);
      const childId = await this.resolveChild(tx, parent.id, invite);

      const { enrollment, figures } =
        await this.ledger.recordMigratedEnrollment(tx, {
          invite,
          childId,
          parentUserId: user.userId,
          actor: { userId: user.userId, role: user.role },
        });

      return { enrollment, figures };
    });

    // Committed. Everything from here is a side effect of a fact that is now
    // true, which is why none of it runs inside the transaction above — see
    // `LedgerService.announceMigratedEnrollment`.
    await this.ledger.announceMigratedEnrollment({
      parentUserId: user.userId,
      schoolId: invite.schoolId,
      schoolName: school.name,
      studentName: invite.studentName,
      className: invite.className,
      amountAlreadyPaid: invite.amountAlreadyPaid,
      remainingBalance: result.figures.remainingBalance,
    });

    // A failure to tell the school must not surface as a failed claim, or the
    // parent retries something that already succeeded.
    //
    // The message NAMES the claimant, and says so loudly when their number is
    // not the one the invite was addressed to. Since holding the link is the
    // only thing a claim requires, this notification is the school's first and
    // best chance to notice that it reached the wrong person — a claim they are
    // told about in the abstract ("claimed by their parent") is one nobody can
    // check. `release` is what they do about it.
    const claimant = await this.describeClaimant(user.userId);
    await this.notifyUser(school.ownerId, {
      title: phoneMatched
        ? 'Migration invite claimed'
        : 'Migration invite claimed — check this one',
      message: phoneMatched
        ? `${invite.studentName} (${invite.className}) was claimed by ${claimant} and now has an active Lopay plan.`
        : `${invite.studentName} (${invite.className}) was claimed by ${claimant}, whose phone number is NOT the one you addressed the invite to. ` +
          'If this is not the right parent, open the invite and remove the claim.',
      type: phoneMatched ? NotificationType.PAYMENT : NotificationType.ALERT,
      // A mismatch needs the invite list, which is where `release` lives; a
      // clean claim belongs on the dashboard, where the roster is. There is no
      // `/school/students` route and the web app has no catch-all, so a link
      // that guesses renders a blank screen.
      link: phoneMatched ? '/school-owner-dashboard' : '/school/invites',
    });

    const { enrollment } = result;
    return {
      enrollmentId: enrollment.id,
      studentName: invite.studentName,
      className: invite.className,
      schoolName: school.name,
      totalFee: Money.fromKobo(enrollment.totalSchoolFee).toNaira(),
      amountAlreadyPaid: Money.fromKobo(enrollment.firstPaymentPaid).toNaira(),
      remainingBalance: Money.fromKobo(enrollment.remainingBalance).toNaira(),
      paymentStatus: enrollment.paymentStatus,
      planStartDate: enrollment.termStartDate,
    };
  }

  /**
   * Run the claim's transaction, translating a unique violation that escapes it
   * into something the parent can act on.
   *
   * Nothing inside that transaction recovers from a constraint violation,
   * because inside a PostgreSQL transaction nothing can: the first violation
   * aborts it, and Prisma sets no per-statement savepoint to roll back to. The
   * recovery is therefore "the whole attempt rolls back, and you try again" —
   * which works, because the retry's reads now see the row that beat it.
   *
   * This exists so that path answers with a 400 saying so, rather than a raw
   * `25P02` 500. Every collision anyone has thought of is already named closer
   * to where it happens — `LedgerService.asMigratedEnrollmentConflict` covers
   * the one-invite-per-plan and one-plan-per-child rules, and `resolveChild`
   * cannot raise at all. So this is a backstop for the unforeseen, and it is
   * here because the unforeseen case is the one where a 500 costs most: the
   * parent is mid-claim on a single-use token and needs to be told to retry,
   * not shown a crash.
   */
  private async runClaimTransaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } catch (error) {
      if (!EnrollmentInvitesService.isUniqueViolation(error)) throw error;
      this.logger.warn(
        `Claim lost a write race and was rolled back: ${errorMessage(error)}`,
      );
      throw new BadRequestException(
        'Something else changed this student’s records while you were confirming. Please try again.',
      );
    }
  }

  /**
   * Contest the figures on an invite without claiming it.
   *
   * Moves the invite to DISPUTED, which takes it out of claimable circulation
   * while keeping the student's slot held — the school can correct it by
   * revoking and re-issuing. The dispute is delivered to the school owner as a
   * notification rather than only stored, because a complaint nobody is told
   * about is not a complaint.
   */
  async dispute(rawToken: unknown, user: AuthUser, reason: string) {
    const { invite } = await this.findByToken(rawToken);

    // `expiresAt` is in the guard for the same reason it is in `claim`'s, and
    // not because `findByToken` has already looked: that retirement is
    // best-effort and its failure is swallowed, so a database blip leaves the
    // row PENDING while the value this method was handed says EXPIRED. Without
    // this clause the write would then succeed against a lapsed invite. The
    // guard has to be the condition the database evaluates, not a check made
    // upstream of it.
    const disputed = await this.prisma.enrollmentInvite.updateMany({
      where: {
        id: invite.id,
        status: EnrollmentInviteStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      data: {
        status: EnrollmentInviteStatus.DISPUTED,
        disputeReason: reason,
        disputedAt: new Date(),
      },
    });
    if (disputed.count === 0) {
      throw new BadRequestException(
        'This invite is no longer awaiting your confirmation.',
      );
    }

    await this.audit.record({
      action: AuditAction.ENROLLMENT_INVITE_DISPUTED,
      entityType: 'EnrollmentInvite',
      entityId: invite.id,
      actor: { userId: user.userId, role: user.role },
      schoolId: invite.schoolId,
      reason,
      before: { status: EnrollmentInviteStatus.PENDING },
      after: { status: EnrollmentInviteStatus.DISPUTED },
    });

    const school = await this.prisma.school.findUnique({
      where: { id: invite.schoolId },
      select: { ownerId: true },
    });
    if (school) {
      await this.notifyUser(school.ownerId, {
        title: 'Parent disputed a migration invite',
        message:
          `A parent says the ${Money.fromKobo(invite.amountAlreadyPaid).formatNaira()} recorded for ` +
          `${invite.studentName} (${invite.className}) is wrong. Their note: “${reason}”`,
        type: NotificationType.ALERT,
        link: '/school/invites',
      });
    }

    return { id: invite.id, status: EnrollmentInviteStatus.DISPUTED };
  }

  // ================================ upkeep =================================

  /**
   * Retire invites whose window has closed. Driven by the scheduler.
   *
   * Every read path re-checks the clock, so an un-swept invite is never
   * claimable — this exists so the school's list tells the truth and so the
   * student's slot is released without anyone having to notice.
   */
  async expireStale(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.enrollmentInvite.updateMany({
      where: {
        status: { in: [...EXPIRABLE_STATUSES] },
        expiresAt: { lte: now },
      },
      data: { status: EnrollmentInviteStatus.EXPIRED },
    });
    if (count > 0) {
      this.logger.log(`Expired ${count} enrollment invite(s)`);
    }
    return count;
  }

  // =============================== internals ===============================

  /**
   * The school this actor may act on, proven against the database.
   *
   * ## Why the session's own `schoolId` is not enough
   *
   * It very nearly is — `RolesGuard` has already established the role and the
   * session carries the school — and every other school-owner service in this
   * codebase stops there. This one does not, and the asymmetry is deliberate
   * rather than an accident of when each was written.
   *
   * A session is a bearer token with a lifetime, and `School.ownerId` and
   * `School.deletedAt` can both move underneath one that is still valid. What
   * this feature does with that window is what makes it worth closing: `create`
   * mints a credential that authorises a stranger to open a fee plan, and
   * `amend` restates money on a live plan a family is paying against. Neither
   * is a read, and neither is undoable by the person it lands on.
   *
   * `deletedAt` is checked for the same reason `claim` checks it: a school that
   * has left the platform should not still be issuing invites into it, and a
   * soft delete previously stopped none of these four paths.
   *
   * ## Why it is one method rather than a check on the risky endpoints
   *
   * Because "the risky ones" is a judgement that has to be re-made every time a
   * method is added, and the first draft of this file got it wrong in exactly
   * that way — `create` re-checked, and `list`, `revoke` and `amend` trusted the
   * session, with a comment on `create` explaining a threat model the other
   * three were exposed to. A rule that lives in one place cannot be forgotten by
   * the next method; the cost is a single indexed primary-key lookup.
   */
  private async assertOwnsSchool(actor: AuthUser): Promise<string> {
    if (actor.role !== UserRole.SCHOOL_OWNER || !actor.schoolId) {
      throw new ForbiddenException(
        'Only a school owner can manage enrollment invites',
      );
    }

    const school = await this.prisma.school.findFirst({
      where: { id: actor.schoolId, ownerId: actor.userId, deletedAt: null },
      select: { id: true },
    });
    if (!school) {
      throw new ForbiddenException(
        'You can only manage enrollment invites for your own school',
      );
    }

    return school.id;
  }

  /**
   * Refuse a second live invite for the same student.
   *
   * Matched case-INSENSITIVELY, deliberately broader than the partial unique
   * index `EnrollmentInvite_live_student_key`, which compares exactly. The two
   * are not in conflict: the index is the guarantee that holds under a race,
   * and this is the usable message — widening it only ever rejects more.
   *
   * It has to be wider, because the input is a human typing a child's name from
   * a register twice. "Ada Lovelace" and "ada lovelace" are the same child and
   * an exact index would happily give them two live invites, two claims and two
   * `Child` rows. The DTO already trims and collapses internal whitespace; case
   * is the part the database cannot fold for us.
   */
  private async assertNoLiveInvite(
    schoolId: string,
    studentName: string,
    className: string,
  ): Promise<void> {
    const existing = await this.prisma.enrollmentInvite.findFirst({
      where: {
        schoolId,
        studentName: { equals: studentName, mode: 'insensitive' },
        className: { equals: className, mode: 'insensitive' },
        status: { in: [...SLOT_HOLDING_STATUSES] },
      },
      select: { status: true },
    });
    if (!existing) return;

    throw new BadRequestException(
      existing.status === EnrollmentInviteStatus.CLAIMED
        ? `${studentName} (${className}) has already been migrated and has a Lopay plan.`
        : `There is already a live invite for ${studentName} in ${className}. Cancel it before issuing another.`,
    );
  }

  /**
   * Resolve a raw token to its invite.
   *
   * Every failure — malformed token, unknown token, expired, already claimed —
   * answers with the SAME message. Distinguishing them would tell someone
   * probing tokens which of their guesses had the right shape or had once been
   * real, and none of those distinctions helps a parent holding a genuine link.
   *
   * An expired invite is flipped to EXPIRED opportunistically here, so the
   * school's list self-heals between scheduler runs.
   */
  private async findByToken(rawToken: unknown) {
    const tokenHash = hashInviteToken(rawToken);
    if (!tokenHash) throw new NotFoundException(INVITE_UNAVAILABLE);

    const invite = await this.prisma.enrollmentInvite.findUnique({
      where: { tokenHash },
      include: { school: { select: { name: true } } },
    });
    if (!invite) throw new NotFoundException(INVITE_UNAVAILABLE);

    if (hasExpired(invite, new Date())) {
      await this.prisma.enrollmentInvite
        .updateMany({
          where: { id: invite.id, status: { in: [...EXPIRABLE_STATUSES] } },
          data: { status: EnrollmentInviteStatus.EXPIRED },
        })
        .catch((error: unknown) =>
          // Best effort: the caller is refused either way by the status check
          // below, and the sweep will catch it.
          this.logger.warn(
            `Could not retire expired invite ${invite.id}: ${errorMessage(error)}`,
          ),
        );
      return {
        invite: { ...invite, status: EnrollmentInviteStatus.EXPIRED },
        tokenHash,
      };
    }

    return { invite, tokenHash };
  }

  /**
   * Whether the claimant's own number is the one the school addressed the invite
   * to. Reported to the school; never used to refuse a claim.
   *
   * ## Why this stopped being a gate
   *
   * It read as a second factor and was not one. Lopay does not verify phone
   * numbers anywhere — there is no OTP, no SMS provider and no `phoneVerified`
   * column — so a "match" only ever proved that somebody typed that number into
   * a signup form. Against anyone holding the link who was willing to do that,
   * it bought nothing.
   *
   * What it reliably did was refuse the right people. These parents are, by the
   * whole premise of this feature, new to Lopay:
   *
   *   - a Google sign-in has no number at all (`signup-guard.ts` makes it
   *     optional precisely so that path works), so the check refused them
   *     outright;
   *   - a parent using a second phone, or the number their spouse registered
   *     with, was refused;
   *   - and when the school mistyped one digit, the check did not prevent the
   *     mistake — it ENFORCED it, making the wrong number the only one that
   *     could claim and locking the real parent out of their own child's plan
   *     with no way back.
   *
   * The link is the credential, and that is a deliberate choice: it is issued
   * and sent inside a conversation the school and the parent have already had,
   * so it arrives expected rather than cold. Misuse is handled where it can
   * actually be handled — by telling the school who claimed, flagging a number
   * that does not match, and letting them undo it (`release`).
   *
   * A null `phoneHash` on the account returns false rather than throwing: it
   * means "we have nothing to compare", which is worth showing the school and is
   * not grounds to refuse anyone.
   */
  private async claimantPhoneMatches(
    invite: { parentPhoneHash: string },
    userId: string,
  ): Promise<boolean> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneHash: true },
    });
    return Boolean(
      account?.phoneHash && account.phoneHash === invite.parentPhoneHash,
    );
  }

  /**
   * Materialise the domain Parent row, mirroring the lazy creation in
   * `EnrollmentService` — and, like `resolveChild` below, without ever raising a
   * unique violation.
   *
   * This used `upsert`, which is the pattern `resolveChild` documents at length
   * as unusable inside a transaction: Prisma does not compile it to `INSERT …
   * ON CONFLICT` here, it issues a SELECT and then an INSERT, so two racing
   * transactions both find nothing, both insert, and the loser raises P2002 —
   * which aborts the whole transaction with no savepoint to recover to.
   *
   * The race is not hypothetical. `Parent` is created lazily by three paths, and
   * a family can reach two of them at once: claiming an invite in one tab while
   * enrolling a sibling normally in another, or two invites for two children
   * claimed together. `claim` would have turned that into its retryable 400,
   * which is an honest answer but an avoidable one — the reasoning that made
   * `resolveChild` use `createMany` applies here unchanged, and `Parent.userId`
   * is unique, so `ON CONFLICT DO NOTHING` resolves it in the database with
   * nothing left to catch.
   */
  private async resolveParent(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ id: string }> {
    const account = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { phoneNumber: true },
    });

    await tx.parent.createMany({
      data: [{ userId, phoneNumber: account.phoneNumber ?? '' }],
      skipDuplicates: true,
    });

    // Returns whichever row won, ours or a concurrent claim's — which is all the
    // caller wanted.
    return tx.parent.findUniqueOrThrow({
      where: { userId },
      select: { id: true },
    });
  }

  /**
   * Find or create the Child row, without ever raising a unique violation.
   *
   * Reuses an existing child rather than failing, because the overlap is
   * ordinary: a family already on Lopay for a sibling, or one that self-enrolled
   * before the invite reached them.
   *
   * ## Why not find-then-create-catching-P2002
   *
   * `EnrollmentService.resolveEnrollmentTarget` uses that pattern and is right
   * to — it runs OUTSIDE any transaction. Inside one it silently cannot work.
   * PostgreSQL aborts the entire transaction on a constraint violation and
   * Prisma issues no per-statement `SAVEPOINT`, so the recovery re-read fails
   * with `25P02 current transaction is aborted` and the parent gets a 500 where
   * the code intended a successful claim. Unreachable recovery that reads like
   * working recovery is worse than none.
   *
   * ## Why `createMany` and not `upsert`
   *
   * Because the whole point is to avoid the exception, and only one of them
   * does. Prisma's `upsert` is NOT compiled to `INSERT … ON CONFLICT` here: it
   * issues a SELECT and then an INSERT, so two racing transactions both find
   * nothing and both insert, and the loser raises P2002 — the exact failure
   * above, just reached by a tidier-looking call. (Verified against Postgres 16
   * through the pg driver adapter, which is how this app connects; the query log
   * shows `SELECT … / INSERT …` with no `ON CONFLICT` clause.)
   *
   * `createMany` with `skipDuplicates` does emit `INSERT … ON CONFLICT DO
   * NOTHING`, which is a single statement the database resolves itself. It
   * cannot raise, so there is nothing to recover from and no transaction to
   * abort. The follow-up read then returns whichever row won, ours or theirs —
   * which is all the caller wanted. Three concurrent claims for the same
   * identity were verified to all succeed against one `Child` row.
   *
   * The column list is Prisma-generated rather than hand-written SQL, so this
   * stays correct if `Child` gains a field.
   *
   * `claim` still maps an escaping unique violation to a retryable 400, for the
   * collisions this method is not responsible for.
   */
  private async resolveChild(
    tx: Prisma.TransactionClient,
    parentId: string,
    invite: { studentName: string; className: string },
  ): Promise<string> {
    const identity = {
      parentId,
      fullName: invite.studentName,
      className: invite.className,
    };

    await tx.child.createMany({ data: [identity], skipDuplicates: true });
    const child = await tx.child.findFirstOrThrow({
      where: identity,
      select: { id: true },
    });
    return child.id;
  }

  /**
   * How a claimant is described to the school owner: a name and a partial
   * number.
   *
   * The number is the point — the school knows which parent they addressed the
   * invite to and will recognise the last digits instantly, where a name alone
   * ("Mrs Adeyemi") may match half a class. It is masked rather than given in
   * full because this lands in a notification row and a push payload, neither
   * of which is a good home for a complete phone number, and the last three
   * digits are enough to recognise a number you already know.
   *
   * Degrades to "someone" rather than throwing. It is called after the claim has
   * committed, and a claim that succeeded must not be reported as failed because
   * a display string could not be built.
   */
  private async describeClaimant(userId: string): Promise<string> {
    try {
      const account = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true, name: true, phoneNumber: true },
      });
      if (!account) return 'someone';

      const name =
        account.fullName?.trim() || account.name?.trim() || 'someone';
      const digits = (account.phoneNumber ?? '').replace(/\D/g, '');
      return digits.length >= 3 ? `${name} (•••${digits.slice(-3)})` : name;
    } catch (error) {
      this.logger.warn(
        `Could not describe claimant ${userId}: ${errorMessage(error)}`,
      );
      return 'someone';
    }
  }

  /** Best-effort: a notification failure must never undo committed work. */
  private async notifyUser(
    ownerId: string,
    payload: {
      title: string;
      message: string;
      type: NotificationType;
      link: string;
    },
  ): Promise<void> {
    try {
      await this.notifications.create({ userId: ownerId, ...payload });
    } catch (error) {
      this.logger.error(
        `Could not notify school owner ${ownerId}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * The share payload: the link, and a pre-written message to go with it.
   *
   * Delivery is the school's own. There is no automated send and no deep link
   * into a particular app — the school copies the link and pastes it into
   * whatever channel it already uses with that parent. That needs no provider,
   * no domain verification and no deliverability problem, and it does not
   * assume the school and the parent share any one messaging app.
   *
   * An earlier cut returned a `wa.me` deep link as the primary action. It was
   * dropped rather than kept as an extra button, because a deep link addressed
   * to a phone number reads as delivery TO that number and is nothing of the
   * kind: `wa.me` opens a draft, and the sender can retarget it to anyone
   * before pressing send. Presenting it as "Send on WhatsApp" implied a
   * guarantee about who received the link that no part of this system makes —
   * and the claim's real check is the phone match at the far end, which is
   * unaffected by how the link travelled.
   *
   * The raw token appears here and NOWHERE else, ever again. It is not stored,
   * not logged, and not returned by any other endpoint: if the school loses the
   * link, the answer is to revoke and re-issue.
   */
  private static buildShare(
    origin: string,
    rawToken: string,
    invite: { studentName: string; className: string; expiresAt: Date },
  ) {
    const claimUrl = buildClaimUrl(origin, rawToken);

    const message =
      `Hello! ${invite.studentName}'s school has set up a Lopay account for your ` +
      `remaining ${invite.className} fees, including what you have already paid. ` +
      `Open this link to check the details and confirm: ${claimUrl}`;

    return { claimUrl, message, expiresAt: invite.expiresAt };
  }

  /**
   * True when a unique constraint rejected a write.
   *
   * Deliberately not narrowed to a particular index. Both callers want the same
   * thing — "the database refused this because something equal already exists" —
   * and each turns it into its own message from the context it already has,
   * which is more reliable than parsing `error.meta.target`. `LedgerService`
   * does inspect the target, because there it genuinely has to tell two
   * reachable collisions apart.
   */
  private static isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  /** Where the web client lives, or a thrown error naming the variable to set. */
  private webAppOrigin(): string {
    return requireWebAppOrigin(this.config, (candidate) =>
      this.logger.error(`Unparseable web app origin "${candidate}"`),
    );
  }
}

/**
 * One message for every way a token can fail to resolve.
 *
 * Deliberately undifferentiated: "malformed", "unknown", "expired" and "already
 * claimed" are all the same answer, because distinguishing them tells someone
 * probing tokens which guesses were structurally right or once existed, and
 * tells a parent with a genuine link nothing they can act on that this does not.
 */
const INVITE_UNAVAILABLE =
  'This invite link is not valid. It may have expired or already been used — ask your school to send a new one.';
