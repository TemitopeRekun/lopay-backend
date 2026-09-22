import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { InstallmentFrequency } from '../../generated/prisma/client';
import {
  MAX_INVITE_EXPIRY_DAYS,
  MIN_INVITE_EXPIRY_DAYS,
  DEFAULT_INVITE_EXPIRY_DAYS,
} from '../invite-policy';

/**
 * What a school owner supplies to invite a parent who already paid them.
 *
 * Note what is ABSENT, and why — both for the same reason.
 *
 * **The total school fee.** The school publishes its fees once, per class,
 * through `POST /school-payments/fees/bulk`, and the invite reads the active
 * `ClassFee` for the class named here. Accepting a per-invite total would let
 * one school hold two different answers to "what does Basic 1 cost?" with
 * nothing reconciling them, and would put the figure the whole plan is derived
 * from into a free-text box. The only money the school types is what the parent
 * has already handed over.
 *
 * **The term end.** `ChildEnrollment.termEndDate` is the plan's end, not the
 * academic term's: the instalment counts are fixed, so it is always exactly the
 * cadence's span, and `ConfirmPlanScreen` derives it that way for every normal
 * enrollment. It is also the cliff that `DefaulterDetectionService` and
 * `computeArrears` both read, which makes a typed date wrong in either
 * direction — too early defaults a family before their first instalment falls
 * due, too late exempts them from defaulting entirely. `derivePlanEnd` computes
 * it from the start date and the cadence, so neither is reachable.
 */
/**
 * Trim, and collapse runs of internal whitespace to a single space.
 *
 * A bare `.trim()` is not enough for a name that decides identity. The student
 * name and class are part of the one-live-invite-per-student key (the partial
 * unique index) and are copied verbatim onto the `Child` row, which is itself
 * unique on `(parentId, fullName, className)`. "Ada  Lovelace" typed with a
 * stray double space is the same child as "Ada Lovelace", and without this it
 * would hold a second slot, claim a second invite and mint a second child.
 *
 * Case is deliberately NOT folded here — schools capitalise names as they
 * please and a stored name should read the way its school wrote it. The
 * case-insensitive comparison lives in `assertNoLiveInvite` instead, where it
 * affects matching without rewriting what anyone typed.
 */
const normalizeName = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

export class CreateEnrollmentInviteDto {
  @ApiProperty({ example: 'Ada Lovelace', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(normalizeName)
  studentName: string;

  @ApiProperty({
    example: 'Basic 1',
    maxLength: 60,
    description: 'Must match an active ClassFee for the school.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(normalizeName)
  className: string;

  @ApiProperty({
    example: 27500,
    description:
      'Naira the parent has already paid the school directly. May be 0. ' +
      'Cannot exceed the class fee.',
  })
  @Type(() => Number)
  // Naira is quoted to two decimals everywhere in this API; anything finer is a
  // float artefact, and rounding it silently would move real money.
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountAlreadyPaid: number;

  @ApiProperty({
    example: '+2348012345678',
    description:
      "The parent's WhatsApp number. Becomes the second factor on the claim: " +
      'only an account whose own verified number matches may claim the invite.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  parentPhone: string;

  @ApiProperty({ enum: InstallmentFrequency, example: 'MONTHLY' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsEnum(InstallmentFrequency)
  installmentFrequency: InstallmentFrequency;

  @ApiProperty({
    example: '2026-09-19T00:00:00.000Z',
    description:
      'When the new plan starts collecting. Anchors the installment schedule ' +
      'and, with the cadence, determines when the plan ends — so it must not be ' +
      'back-dated into a term that has already run, which would open the plan ' +
      'in arrears.',
  })
  @Type(() => Date)
  @IsDate()
  planStartDate: Date;

  @ApiPropertyOptional({
    example: DEFAULT_INVITE_EXPIRY_DAYS,
    minimum: MIN_INVITE_EXPIRY_DAYS,
    maximum: MAX_INVITE_EXPIRY_DAYS,
    // Deliberately NOT declared as `default` in the schema. openapi-typescript
    // emits a property carrying a default as non-optional — correct for a
    // response, where the server always fills it, but wrong for a request body:
    // it would force every caller to send a value they are entitled to omit.
    // The default lives in `invite-policy.ts` and is stated here in prose.
    description:
      `How long the claim link stays valid. Defaults to ${DEFAULT_INVITE_EXPIRY_DAYS} days. ` +
      'Clamped server-side — the token is a bearer credential sitting in a chat ' +
      'thread, so it is not left open-ended.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(MIN_INVITE_EXPIRY_DAYS)
  @Max(MAX_INVITE_EXPIRY_DAYS)
  @IsOptional()
  expiresInDays?: number;
}
