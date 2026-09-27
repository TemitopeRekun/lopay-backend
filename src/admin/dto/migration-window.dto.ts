import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * A platform admin moving one school's free-migration deadline.
 *
 * ## Why an absolute date rather than "extend by N days"
 *
 * A relative extension reads more safely and is not. Applied naively to a
 * school whose window closed a fortnight ago, "+7 days" lands a week in the
 * PAST and changes nothing the admin can see — they grant the extension, the
 * school still cannot issue, and the next call is a support escalation about a
 * feature that appears broken. An absolute date says exactly what the school
 * gets, and it is the value the admin can read back on the list beside it.
 *
 * It also does both jobs. Granting more time and shutting a school's migration
 * off early are the same edit in opposite directions, and one endpoint that
 * states the resulting date is clearer than two that each describe a motion.
 *
 * The bounds are in `AdminService.setMigrationWindow` rather than here, because
 * they are relative to *now* and a DTO cannot express that.
 */
export class SetMigrationWindowDto {
  @ApiProperty({
    example: '2026-11-30T00:00:00.000Z',
    description:
      'When this school stops being able to ISSUE migration invites. ' +
      'Must be within a year from now, and no earlier than yesterday — ' +
      'a date in the past closes migration immediately, which is allowed ' +
      'on purpose so a school can be stopped as well as extended.',
  })
  @Type(() => Date)
  @IsDate()
  closesAt: Date;

  /**
   * Required, not optional.
   *
   * Every other `reason` on this codebase's admin actions is optional because
   * the action itself is self-explanatory. This one changes what a school is
   * given for free, which is a commercial decision — and the person who has to
   * understand it later is not the person making it now.
   */
  @ApiProperty({
    example: 'Still migrating 120 families; agreed a further month on 23 Sep.',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
