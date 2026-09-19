import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator';
import { EnrollmentInviteStatus } from '../../generated/prisma/client';
import { INVITE_TOKEN_LENGTH } from '../invite-token';

/**
 * The claim token, carried in a request BODY rather than the URL.
 *
 * It is a bearer credential: whoever holds it can see the invite and, with the
 * matching phone, claim it. A query string is the wrong place for one — it is
 * written to web-server and reverse-proxy access logs, attached to Sentry
 * breadcrumbs, kept in browser history, and leaked in the `Referer` header of
 * any subsequent navigation. A body is none of those things.
 *
 * The `preview` route is the exception and takes the token in a request header
 * for the same reason: it is a GET, so it has no body to put it in.
 */
export class ClaimEnrollmentInviteDto {
  @ApiProperty({
    description: 'The raw claim token from the invite link.',
    minLength: INVITE_TOKEN_LENGTH,
    maxLength: INVITE_TOKEN_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  // Bounded here as well as in `hashInviteToken`, so a megabyte of junk is
  // rejected by the pipe before any of our code touches it.
  @Length(INVITE_TOKEN_LENGTH, INVITE_TOKEN_LENGTH)
  token: string;
}

export class DisputeEnrollmentInviteDto {
  @ApiProperty({
    description: 'The raw claim token from the invite link.',
    minLength: INVITE_TOKEN_LENGTH,
    maxLength: INVITE_TOKEN_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @Length(INVITE_TOKEN_LENGTH, INVITE_TOKEN_LENGTH)
  token: string;

  @ApiProperty({
    example: 'The school has ₦25,000 but I paid ₦35,000 on 3 September.',
    maxLength: 500,
    description:
      'Shown verbatim to the school owner, so it is length-bounded and stored ' +
      'as given. React escapes it on render.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class RevokeEnrollmentInviteDto {
  @ApiPropertyOptional({
    example: 'Wrong phone number',
    maxLength: 500,
    description: 'Recorded on the audit trail.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}

/**
 * Correcting the already-paid figure on a plan that has already been claimed.
 *
 * Separate from revoking: once claimed there is a live plan a family is paying
 * against, so the fix is to restate the number and let the balance re-derive,
 * not to delete anything. See `LedgerService.amendMigratedPayment`.
 */
export class AmendMigratedPaymentDto {
  @ApiProperty({
    example: 35000,
    description: 'The corrected naira figure the parent had already paid.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountAlreadyPaid: number;

  @ApiPropertyOptional({
    example: 'Bank statement showed a second transfer on 3 September.',
    maxLength: 500,
    description: 'Recorded on the audit trail and shown to the parent.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}

/** Filters for the school owner's invite list. */
export class ListEnrollmentInvitesDto {
  @ApiPropertyOptional({ enum: EnrollmentInviteStatus })
  @IsEnum(EnrollmentInviteStatus)
  @IsOptional()
  status?: EnrollmentInviteStatus;

  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({
    example: 25,
    minimum: 1,
    description: 'Clamped server-side by `parsePagination`.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  limit?: number;
}
