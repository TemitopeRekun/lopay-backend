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
  isMigrationWindowOpen,
  migrationDaysRemaining,
  validatePlanStart,
} from './invite-policy';
import { toParentInviteView, toSchoolInviteView } from './invite-view';
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
    const { id: schoolId, migrationDeadline } =
      await this.assertOwnsSchool(actor);
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

    // The migration window, checked before anything else about the request.
    // It is a property of the SCHOOL rather than of this invite, so a closed
    // window means every field below is moot — and failing here keeps the
    // message about the thing the owner actually has to act on.
    if (!isMigrationWindowOpen(migrationDeadline, now)) {
      throw new BadRequestException(
        'Your migration window has closed, so new invites cannot be issued. ' +
          'Migration is a one-time, free onboarding step for families who had ' +
          'already paid you before joining Lopay — enrol new students normally ' +
          'from here. If you still have families to migrate, contact Lopay to ' +
          'have the window extended.',
      );
    }

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

    // Already migrated, in any class, at any time — checked BEFORE the fee
    // lookup because it is terminal in a way the fee is not. A school migrating
    // Ada into Basic 2 when she was migrated in Basic 1 would otherwise be told
    // "no fee is published for Basic 2" and sent to publish one that will not
    // help them, only to be refused again for the real reason. Order the
    // refusals so the first one names the thing the owner has to act on.
    await this.assertNotAlreadyMigrated(schoolId, dto.studentName);

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
  async list(actor: AuthUser, filters: ListEnrollmentInvitesDto) {
    const { id: schoolId, migrationDeadline } =
      await this.assertOwnsSchool(actor);
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

    // The window rides on the list response rather than needing its own call.
    // The screen has to state it BEFORE the owner fills in a form and is
    // refused — a rule the UI only discovers by being told "no" is a rule the
    // UI has failed to explain.
    return {
      ...paginate(
        rows.map((row) => toSchoolInviteView(row, now)),
        total,
        page,
        limit,
      ),
      migrationWindow: {
        closesAt: migrationDeadline,
        daysRemaining: migrationDaysRemaining(migrationDeadline, now),
        isOpen: isMigrationWindowOpen(migrationDeadline, now),
      },
    };
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
    const { id: schoolId } = await this.assertOwnsSchool(actor);

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
   * Mint a fresh link for an invite whose own link is gone.
   *
   * ## Why this has to exist
   *
   * The raw token is returned exactly once and stored only as a SHA-256 digest,
   * so no endpoint can reproduce it — a property worth keeping, and the reason
   * `buildShare` says so on screen. But "worth keeping" is not the same as
   * "the school should pay for it". Before this, a closed tab meant the owner
   * had to revoke the invite and re-enter every field by hand, and re-entering
   * is exactly where the already-paid figure gets mistyped — a number the
   * parent is then asked to confirm as their own balance.
   *
   * Re-issuing in place costs nothing and keeps the security property intact:
   * `tokenHash` is overwritten, so the previous link is dead the moment this
   * returns, whoever is holding it.
   *
   * ## Why the row is updated rather than replaced
   *
   * A revoke-and-recreate pair would work, but it churns the one-live-invite
   * slot inside a transaction for no gain and leaves the school's list showing
   * two rows for one child — with the dead one carrying the history. Updating
   * keeps one row per student, which is what every other part of this feature
   * assumes, and the audit trail records the re-issue against the same entity.
   *
   * ## What it refuses, and why each
   *
   *   - **CLAIMED** — there is a live plan and a family paying against it.
   *     Correcting the figure is `amend`; undoing the wrong claimant is
   *     `release`. Minting a second link would be neither.
   *   - **DISPUTED** — the parent has said the amount is wrong. Handing them
   *     the same figures again is not a resend, it is ignoring them.
   *   - **REVOKED** — the school cancelled it deliberately, almost always
   *     because a detail was wrong. Re-issuing the same details would restore
   *     the mistake they took an action to remove.
   *
   * PENDING (lost the link) and EXPIRED (nobody claimed in time) are the two
   * that mean "send it again", and they are the two allowed.
   */
  async reissue(inviteId: string, actor: AuthUser) {
    const { id: schoolId, migrationDeadline } =
      await this.assertOwnsSchool(actor);
    const now = new Date();

    // Resolved before anything is written, for the same reason `create` does
    // it: the raw token is the only copy and it dies with the stack frame if
    // this throws after the update.
    const origin = this.webAppOrigin();

    // Gated on the window exactly as issuing is, because that is what this is.
    // Claiming is deliberately NOT gated (see `isMigrationWindowOpen`) — a
    // parent must be able to open a link their school sent before the deadline
    // — but minting a NEW credential after it has passed would make the bound
    // on free migration unenforceable by simply re-issuing forever.
    if (!isMigrationWindowOpen(migrationDeadline, now)) {
      throw new BadRequestException(
        'Your migration window has closed, so new invite links cannot be issued. ' +
          'Contact Lopay if you still have families to migrate.',
      );
    }

    const invite = await this.prisma.enrollmentInvite.findFirst({
      where: { id: inviteId, schoolId },
    });
    if (!invite) throw new NotFoundException('Invite not found');

    const token = mintInviteToken();
    const expiresAt = expiryFrom(now);

    // Conditional, like every other write here: two owners tapping at once, or
    // a re-issue racing a claim, must resolve to exactly one winner rather than
    // both "succeeding" — and the loser must not be the one whose link the
    // school actually sent.
    const reissued = await this.prisma.enrollmentInvite.updateMany({
      where: {
        id: inviteId,
        schoolId,
        status: {
          in: [EnrollmentInviteStatus.PENDING, EnrollmentInviteStatus.EXPIRED],
        },
      },
      data: {
        status: EnrollmentInviteStatus.PENDING,
        tokenHash: token.tokenHash,
        expiresAt,
      },
    });

    if (reissued.count === 0) {
      throw new BadRequestException(REISSUE_REFUSALS[invite.status]);
    }

    await this.audit.record({
      // Deliberately the CREATED action rather than a new one: what happened is
      // that a fresh claim credential was minted for this student, which is
      // what that action already means. `reissuedFrom` is what tells the two
      // apart for anyone reading the trail.
      action: AuditAction.ENROLLMENT_INVITE_CREATED,
      entityType: 'EnrollmentInvite',
      entityId: inviteId,
      actor: { userId: actor.userId, role: actor.role },
      schoolId,
      before: { status: invite.status, expiresAt: invite.expiresAt },
      after: { status: EnrollmentInviteStatus.PENDING, expiresAt },
      metadata: {
        reissuedFrom: invite.status,
        studentName: invite.studentName,
        className: invite.className,
        // As in `create`: neither the phone number nor its blind index is
        // recorded here. See the note there.
      },
    });

    return {
      invite: toSchoolInviteView({ ...invite, expiresAt }, now),
      ...EnrollmentInvitesService.buildShare(origin, token.token, {
        ...invite,
        expiresAt,
      }),
    };
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
    const { id: schoolId } = await this.assertOwnsSchool(actor);

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
    const { id: schoolId } = await this.assertOwnsSchool(actor);

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

    // Already migrated under a DIFFERENT invite.
    //
    // Reachable without any race: a school may issue an invite for Ada in
    // Basic 1 and another for Ada in Basic 2, because the slot index is scoped
    // per class and both are live. Claiming the first is fine; the second would
    // violate `EnrollmentInvite_migrated_student_key` deep inside the
    // transaction and surface as the generic "please try again", which is the
    // one piece of advice that cannot work — retrying does the same thing.
    // Checked here so the answer names the actual situation.
    await this.assertNotAlreadyMigrated(invite.schoolId, invite.studentName);

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
    await this.notifyUser(
      school.ownerId,
      EnrollmentInvitesService.claimNotification(
        invite,
        claimant,
        phoneMatched,
      ),
    );

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

      // The one-migration-per-student index is NOT a losable race: a second
      // claim for a student already migrated fails identically however many
      // times it is retried, so telling the parent to try again would be a
      // loop. The pre-check in `claim` catches this in almost every case; this
      // covers two claims landing in the same instant.
      if (EnrollmentInvitesService.isAlreadyMigratedViolation(error)) {
        this.logger.warn(
          `Claim refused: student already migrated — ${errorMessage(error)}`,
        );
        throw new BadRequestException(
          'This student has already been migrated onto Lopay. Ask your school to ' +
            'check their plan rather than sending another invite.',
        );
      }

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
   * Retire invites whose window has closed, and tell the school which ones.
   *
   * Every read path re-checks the clock, so an un-swept invite is never
   * claimable — the sweep exists so the school's list tells the truth and so
   * the student's slot is released without anyone having to notice.
   *
   * The notification is the part that was missing, and its absence is how a
   * migration campaign fails quietly: an invite lapsed, a row changed colour on
   * a screen nobody had open, and the family was simply never migrated. A
   * school only finds out by going and looking, which is precisely the thing
   * they have no reason to do.
   *
   * Rows are read BEFORE the update because afterwards there is no way to tell
   * which ones this sweep retired from the ones already sitting at EXPIRED.
   */
  async expireStale(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.enrollmentInvite.findMany({
      where: {
        status: { in: [...EXPIRABLE_STATUSES] },
        expiresAt: { lte: now },
      },
      select: { id: true, schoolId: true, studentName: true, className: true },
    });
    if (due.length === 0) return 0;

    const { count } = await this.prisma.enrollmentInvite.updateMany({
      where: { id: { in: due.map((invite) => invite.id) } },
      data: { status: EnrollmentInviteStatus.EXPIRED },
    });
    this.logger.log(`Expired ${count} enrollment invite(s)`);

    await this.notifySchools(due, (students, ownerId) =>
      this.notifyUser(ownerId, {
        title: 'Migration invites expired unclaimed',
        message:
          `${describeStudents(students)} did not confirm before the link expired, so ` +
          'nothing has been added to their account. Open the invite and send a new link.',
        type: NotificationType.ALERT,
        link: '/school/invites',
      }),
    );

    return count;
  }

  /**
   * Warn a school about links about to lapse, while there is still time to
   * chase the family.
   *
   * ## Why the school and not the parent
   *
   * Because there is no way to reach the parent. The whole premise of this
   * feature is that they have no Lopay account yet, so there is no `userId` to
   * write a notification against — `NotificationsService.create` requires one —
   * and this platform has no SMS or email provider to fall back on. The only
   * party with a channel to that family is the school, which already has the
   * thread the link was sent in. Telling them, in time, IS the reminder;
   * anything addressed to the parent would need a messaging provider this app
   * does not have.
   *
   * ## Why a fixed window and no `remindedAt` column
   *
   * Each daily run selects the invites lapsing in exactly one 24-hour bucket,
   * `[now + 3d, now + 4d)`. Every PENDING invite passes through exactly one
   * such bucket in its life, so it is reminded once — without a column to track
   * it, and without a migration to add one.
   *
   * The trade is that a run missed entirely — a deploy, an outage — skips that
   * day's cohort rather than catching them late. Acceptable: this is a courtesy
   * nudge, not a correctness guarantee. Nothing about whether an invite can be
   * claimed depends on it, and the expiry notice above still fires.
   *
   * DISPUTED is excluded deliberately. Those have not gone quiet — the parent
   * answered, and said the figure is wrong. The school already has that
   * notification, and chasing them for a confirmation they have refused to give
   * would be the wrong ask.
   */
  async remindExpiring(now: Date = new Date()): Promise<number> {
    const from = new Date(now.getTime() + EXPIRY_REMINDER_LEAD_MS);
    const to = new Date(from.getTime() + DAY_IN_MS);

    const soon = await this.prisma.enrollmentInvite.findMany({
      where: {
        status: EnrollmentInviteStatus.PENDING,
        expiresAt: { gte: from, lt: to },
      },
      select: { id: true, schoolId: true, studentName: true, className: true },
    });
    if (soon.length === 0) return 0;

    await this.notifySchools(soon, (students, ownerId) =>
      this.notifyUser(ownerId, {
        title: 'Migration invites expire in 3 days',
        message:
          `${describeStudents(students)} have not confirmed yet. Send a reminder, ` +
          'or the link will expire and you will need to issue a new one.',
        type: NotificationType.ALERT,
        link: '/school/invites',
      }),
    );

    this.logger.log(`Reminded schools about ${soon.length} expiring invite(s)`);
    return soon.length;
  }

  /**
   * Group invites by school and notify each owner once.
   *
   * One notification per school rather than per invite, because a school
   * migrating thirty families would otherwise get thirty notifications in one
   * tick — which lands the same as getting none. A school soft-deleted since
   * the invites were issued is skipped rather than notified about a roster it
   * no longer has.
   */
  private async notifySchools(
    invites: readonly InviteSummary[],
    notify: (students: InviteSummary[], ownerId: string) => Promise<void>,
  ): Promise<void> {
    const bySchool = new Map<string, InviteSummary[]>();
    for (const invite of invites) {
      const group = bySchool.get(invite.schoolId);
      if (group) group.push(invite);
      else bySchool.set(invite.schoolId, [invite]);
    }

    const schools = await this.prisma.school.findMany({
      where: { id: { in: [...bySchool.keys()] }, deletedAt: null },
      select: { id: true, ownerId: true },
    });

    for (const school of schools) {
      const students = bySchool.get(school.id);
      if (students?.length) await notify(students, school.ownerId);
    }
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
  private async assertOwnsSchool(
    actor: AuthUser,
  ): Promise<{ id: string; migrationDeadline: Date }> {
    if (actor.role !== UserRole.SCHOOL_OWNER || !actor.schoolId) {
      throw new ForbiddenException(
        'Only a school owner can manage enrollment invites',
      );
    }

    const school = await this.prisma.school.findFirst({
      where: { id: actor.schoolId, ownerId: actor.userId, deletedAt: null },
      select: { id: true, migrationDeadline: true },
    });
    if (!school) {
      throw new ForbiddenException(
        'You can only manage enrollment invites for your own school',
      );
    }

    // The deadline rides along because `create` needs it and this is the one
    // read that has already proven the caller may see this school at all.
    return school;
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
    // NOTE: the permanent "already migrated in any class" rule is NOT here — it
    // runs earlier in `create`, ahead of the fee lookup, because it is terminal
    // and the fee is not. This method owns only the per-class slot.
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
   * Refuse a student who has already been migrated once, whatever class they
   * were in at the time.
   *
   * Matched case-insensitively for the same reason the slot check is, and with
   * more at stake: the database index behind this one folds case too
   * (`lower("studentName")`), unlike the older slot index, because retyping a
   * child's name with different capitalisation would otherwise buy a second free
   * migration — and retyping is exactly how the name gets entered.
   *
   * Scoped to CLAIMED, so a released claim frees the student again. That is what
   * `release` is for: the claim reached the wrong person and never should have
   * counted.
   */
  private async assertNotAlreadyMigrated(
    schoolId: string,
    studentName: string,
  ): Promise<void> {
    const migrated = await this.prisma.enrollmentInvite.findFirst({
      where: {
        schoolId,
        studentName: { equals: studentName, mode: 'insensitive' },
        status: EnrollmentInviteStatus.CLAIMED,
      },
      select: { className: true },
    });
    if (!migrated) return;

    throw new BadRequestException(
      `${studentName} has already been migrated onto Lopay (in ${migrated.className}), ` +
        'and migration is a one-time step per student. Enrol them normally for this term.',
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
   * ## Why the answer is three-valued, not two
   *
   * Because "we compared and they differ" and "there was nothing to compare"
   * are different facts, and only the first is worth a school's attention.
   *
   * This returned `false` for both, which was survivable only while Google
   * sign-in was broken — no claimant could arrive without a number, so the
   * ambiguous case never occurred in practice. Now that it works, it is the
   * COMMON case: a Google account carries no phone number at all
   * (`signup-guard.ts` makes it optional precisely so that path works), so
   * every parent who signs in that way would be reported to their school as
   * "whose phone number is NOT the one you addressed the invite to" — which is
   * not merely unhelpful, it is false.
   *
   * That matters more than a wording nit, because this signal is the ONLY
   * compensating control for a claim authorised by holding a link. A warning
   * that fires on most legitimate claims is a warning schools learn to dismiss,
   * and the one genuine misdirected claim goes with it. So: `true` matched,
   * `false` compared and differed, `null` nothing to compare.
   *
   * `null` is what the column and `SchoolInviteView` already meant by it, and
   * `EnrollmentInvitesScreen` already keys its warning off `=== false`, so the
   * third state lands where the rest of the feature was already expecting it.
   */
  private async claimantPhoneMatches(
    invite: { parentPhoneHash: string },
    userId: string,
  ): Promise<boolean | null> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneHash: true },
    });
    if (!account?.phoneHash) return null;
    return account.phoneHash === invite.parentPhoneHash;
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
   * What the school is told when an invite is claimed.
   *
   * ## Why this is three messages and not two
   *
   * Because holding the link is the whole authorisation, this notification is
   * the school's first and best chance to notice that a link reached the wrong
   * person — and `release` is what they do about it. A claim reported in the
   * abstract ("claimed by their parent") is one nobody can check, which is why
   * the claimant is named and the number comparison is stated.
   *
   * The comparison has three outcomes and they need three different messages:
   *
   *   - **matched** — nothing to do; this belongs on the dashboard with the
   *     rest of the roster.
   *   - **differed** — worth a look, and the only one that should read as an
   *     alarm. Links to the invite list, where `release` lives.
   *   - **nothing to compare** — the claimant signed in with Google and has no
   *     number on their account. Reporting this as a mismatch would be false,
   *     and (since Google sign-in works) it would be the majority of claims,
   *     which is how a school learns to dismiss the one warning that matters.
   *     Stated plainly instead, as information rather than an alert.
   *
   * There is no `/school/students` route and the web app has no catch-all, so a
   * link that guesses renders a blank screen — hence only the two that exist.
   */
  private static claimNotification(
    invite: { studentName: string; className: string },
    claimant: string,
    phoneMatched: boolean | null,
  ): {
    title: string;
    message: string;
    type: NotificationType;
    link: string;
  } {
    const who = `${invite.studentName} (${invite.className})`;

    if (phoneMatched === true) {
      return {
        title: 'Migration invite claimed',
        message: `${who} was claimed by ${claimant} and now has an active Lopay plan.`,
        type: NotificationType.PAYMENT,
        link: '/school-owner-dashboard',
      };
    }

    if (phoneMatched === false) {
      return {
        title: 'Migration invite claimed — check this one',
        message:
          `${who} was claimed by ${claimant}, whose phone number is NOT the one you addressed the invite to. ` +
          'If this is not the right parent, open the invite and remove the claim.',
        type: NotificationType.ALERT,
        link: '/school/invites',
      };
    }

    return {
      title: 'Migration invite claimed',
      message:
        `${who} was claimed by ${claimant} and now has an active Lopay plan. ` +
        'They signed in with Google, so there was no phone number on their account to check ' +
        'against the one you addressed the invite to. If this is not the right parent, open the invite and remove the claim.',
      type: NotificationType.PAYMENT,
      link: '/school-owner-dashboard',
    };
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
  /**
   * True when the violated constraint is the permanent one-migration-per-student
   * index, rather than any of the recoverable collisions.
   *
   * Named by index, deliberately, where `isUniqueViolation` refuses to be: the
   * two cases need OPPOSITE advice. Every other unique collision here is a race
   * whose recovery genuinely is "try again, the retry's reads see the row that
   * beat it". This one is a rule, and retrying it forever produces the same
   * refusal. Getting that backwards sends a parent into a loop.
   */
  private static isAlreadyMigratedViolation(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return false;
    }
    const target: unknown = error.meta?.target;
    const asText = Array.isArray(target)
      ? target.filter((p): p is string => typeof p === 'string').join(',')
      : typeof target === 'string'
        ? target
        : '';
    return asText.includes('EnrollmentInvite_migrated_student_key');
  }

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
/** The columns the sweeps read. Narrower than the row, and all the copy needs. */
interface InviteSummary {
  readonly schoolId: string;
  readonly studentName: string;
  readonly className: string;
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;

/**
 * How far ahead of expiry a school is warned.
 *
 * Three days, because the action it asks for is "go and chase a parent", and
 * that needs to survive a weekend or a day the head teacher is out. Much longer
 * and the link is not yet urgent enough to act on; much shorter and there is no
 * time left to act at all.
 */
const EXPIRY_REMINDER_LEAD_MS = 3 * DAY_IN_MS;

/** How many students a notification names before it starts counting instead. */
const MAX_NAMED_STUDENTS = 3;

/**
 * Name the students, up to a point.
 *
 * A school migrating a whole class produces a list no notification row can
 * render and a push payload truncates somewhere arbitrary. Naming the first few
 * and counting the rest keeps the message recognisable, which is the whole
 * point: the owner should be able to tell WHICH families without opening the
 * app.
 */
function describeStudents(students: readonly InviteSummary[]): string {
  const named = students
    .slice(0, MAX_NAMED_STUDENTS)
    .map((student) => `${student.studentName} (${student.className})`);
  const remaining = students.length - named.length;

  if (remaining > 0) {
    const plural = remaining === 1 ? '' : 's';
    return `${named.join(', ')} and ${remaining} other${plural}`;
  }
  if (named.length === 1) return named[0];
  const last = named[named.length - 1];
  return `${named.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * Why a re-issue was refused, by the status that refused it.
 *
 * Each names the action that IS right for that state, because "no" on its own
 * leaves a school owner guessing between three buttons that all sound plausible.
 */
const REISSUE_REFUSALS: Record<EnrollmentInviteStatus, string> = {
  CLAIMED:
    'This invite has already been claimed, so a new link would do nothing. ' +
    'To correct the amount use "Correct amount"; if the wrong person claimed it, remove the claim.',
  DISPUTED:
    'This parent says the recorded amount is wrong. Sending the same link again ' +
    'will not resolve it — cancel this invite and issue a corrected one.',
  REVOKED:
    'This invite was cancelled, so re-sending it would restore whatever was wrong with it. ' +
    'Create a new invite for this student instead.',
  // Both reachable only by losing the race in `reissue`'s conditional write.
  PENDING:
    'This invite was just changed by someone else — reload and try again.',
  EXPIRED:
    'This invite was just changed by someone else — reload and try again.',
};

const INVITE_UNAVAILABLE =
  'This invite link is not valid. It may have expired or already been used — ask your school to send a new one.';
