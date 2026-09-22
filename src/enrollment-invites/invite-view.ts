/**
 * Response projections for enrollment invites.
 *
 * Two audiences see an invite, and they must not see the same thing. These are
 * explicit allow-lists for the same reason `enrollment-view.ts` is one: a
 * `{ ...invite }` spread here would ship `tokenHash` and `parentPhoneHash` to a
 * browser. The first is the stored half of a bearer credential; the second is a
 * stable cross-account identifier for a phone number, which is precisely why
 * `User.phoneHash` is marked `returned: false` in the auth config. Neither has
 * any business leaving the server, and neither can if the only way to build a
 * response is through a function that lists its fields.
 *
 * Money crosses this boundary as naira, integer kobo stays behind it (ADR 0001).
 */

import { Money } from '../common/money';
import { isActionable } from './invite-policy';
import type {
  EnrollmentInviteStatus,
  InstallmentFrequency,
} from '../generated/prisma/client';

/** The columns a projection is allowed to read. Narrower than the Prisma row. */
export interface InviteRow {
  id: string;
  schoolId: string;
  studentName: string;
  className: string;
  totalSchoolFee: number;
  amountAlreadyPaid: number;
  phoneNumber: string;
  installmentFrequency: InstallmentFrequency;
  planStartDate: Date;
  termEndDate: Date;
  expiresAt: Date;
  status: EnrollmentInviteStatus;
  disputeReason: string | null;
  disputedAt: Date | null;
  revokedAt: Date | null;
  claimedAt: Date | null;
  claimantPhoneMatched: boolean | null;
  createdAt: Date;
  school?: { name?: string | null } | null;
  enrollment?: { id: string } | null;
  /**
   * The account that claimed, for the school to recognise. `phoneHash` is
   * deliberately NOT here: the match is decided at claim time and stored, so
   * nothing downstream needs the hash — which is exactly the cross-account
   * identifier this module exists to keep off the wire.
   */
  claimedBy?: { fullName?: string | null; name?: string | null } | null;
}

/** What the school owner's invite list renders. */
export interface SchoolInviteView {
  id: string;
  studentName: string;
  className: string;
  totalFee: number;
  amountAlreadyPaid: number;
  remainingBalance: number;
  /** The number the school entered, so they can check it and re-send. */
  parentPhone: string;
  installmentFrequency: InstallmentFrequency;
  planStartDate: Date;
  termEndDate: Date;
  expiresAt: Date;
  status: EnrollmentInviteStatus;
  /** True while the parent can still act on it — drives the "Share"/"Revoke" affordances. */
  isLive: boolean;
  disputeReason: string | null;
  disputedAt: Date | null;
  revokedAt: Date | null;
  claimedAt: Date | null;
  createdAt: Date;
  /** Present once claimed, so the school can jump to the resulting plan. */
  enrollmentId: string | null;
  /**
   * Who claimed it, so the school can tell whether the link reached the right
   * family. Null until claimed.
   */
  claimedByName: string | null;
  /**
   * Whether that person's phone was the number the invite was addressed to.
   *
   * A signal, not a verdict — claiming is authorised by holding the link alone
   * (see `EnrollmentInvitesService.claimantPhoneMatches`). `false` means "worth
   * a look"; `null` means not claimed, or claimed before this was recorded.
   */
  claimantPhoneMatched: boolean | null;
}

/**
 * What the claim screen renders, BEFORE the visitor has proved anything beyond
 * holding the link.
 *
 * Deliberately thin. Whoever opens a forwarded WhatsApp message reaches this,
 * so it carries only what a parent needs in order to recognise the invite as
 * theirs and check the figures: the child, the class, the school, the money, the
 * dates. No phone number (not even masked — a mask still confirms a number to
 * someone testing one), no school contact or settlement details, no invite id
 * usable anywhere else, and nothing about who created it.
 */
export interface ParentInviteView {
  studentName: string;
  className: string;
  schoolName: string | null;
  totalFee: number;
  amountAlreadyPaid: number;
  remainingBalance: number;
  installmentFrequency: InstallmentFrequency;
  planStartDate: Date;
  termEndDate: Date;
  expiresAt: Date;
  status: EnrollmentInviteStatus;
  /** False once claimed, revoked, expired or disputed — the screen shows why instead of a button. */
  canClaim: boolean;
}

export function toSchoolInviteView(
  invite: InviteRow,
  now: Date = new Date(),
): SchoolInviteView {
  return {
    id: invite.id,
    studentName: invite.studentName,
    className: invite.className,
    totalFee: Money.fromKobo(invite.totalSchoolFee).toNaira(),
    amountAlreadyPaid: Money.fromKobo(invite.amountAlreadyPaid).toNaira(),
    remainingBalance: Money.fromKobo(
      invite.totalSchoolFee - invite.amountAlreadyPaid,
    ).toNaira(),
    parentPhone: invite.phoneNumber,
    installmentFrequency: invite.installmentFrequency,
    planStartDate: invite.planStartDate,
    termEndDate: invite.termEndDate,
    expiresAt: invite.expiresAt,
    status: invite.status,
    isLive: isClaimable(invite, now),
    disputeReason: invite.disputeReason,
    disputedAt: invite.disputedAt,
    revokedAt: invite.revokedAt,
    claimedAt: invite.claimedAt,
    createdAt: invite.createdAt,
    enrollmentId: invite.enrollment?.id ?? null,
    claimedByName:
      invite.claimedBy?.fullName?.trim() ||
      invite.claimedBy?.name?.trim() ||
      null,
    claimantPhoneMatched: invite.claimantPhoneMatched,
  };
}

export function toParentInviteView(
  invite: InviteRow,
  now: Date = new Date(),
): ParentInviteView {
  return {
    studentName: invite.studentName,
    className: invite.className,
    schoolName: invite.school?.name ?? null,
    totalFee: Money.fromKobo(invite.totalSchoolFee).toNaira(),
    amountAlreadyPaid: Money.fromKobo(invite.amountAlreadyPaid).toNaira(),
    remainingBalance: Money.fromKobo(
      invite.totalSchoolFee - invite.amountAlreadyPaid,
    ).toNaira(),
    installmentFrequency: invite.installmentFrequency,
    planStartDate: invite.planStartDate,
    termEndDate: invite.termEndDate,
    expiresAt: invite.expiresAt,
    status: invite.status,
    canClaim: isClaimable(invite, now),
  };
}

/**
 * Claimable means actionable *and* inside its window.
 *
 * The clock is re-checked rather than `status` being trusted alone: the sweep
 * that flips PENDING to EXPIRED runs hourly, so between the moment an invite
 * lapses and the moment the sweep reaches it the column still says PENDING.
 * Every read path therefore consults the time, and a claim that slips through
 * anyway is refused by the conditional write in the service.
 *
 * Both halves come from `invite-policy.ts` rather than being spelled out here.
 * They were inline once, and an inline copy of "what counts as claimable" is
 * exactly how a projection ends up offering a button the API will reject.
 */
function isClaimable(
  invite: { status: EnrollmentInviteStatus; expiresAt: Date },
  now: Date,
): boolean {
  return (
    isActionable(invite.status) && invite.expiresAt.getTime() > now.getTime()
  );
}
