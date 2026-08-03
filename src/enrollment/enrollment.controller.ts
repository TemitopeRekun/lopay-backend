import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { EnrollmentService } from './enrollment.service';
import { CreateEnrollmentDto } from './dto/create.enrollment.dto';
import { ConfirmEnrollmentDto } from './dto/confirm.enrollment.dto';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { CreateInstallmentDto } from './dto/create.installment.dto';

@ApiTags('enrollments')
@ApiBearerAuth()
@Controller('enrollments')
export class EnrollmentController {
  constructor(private readonly enrollmentService: EnrollmentService) {}

  @SkipThrottle()
  @Get('my-children')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER)
  @ApiOperation({ summary: "List the current parent's enrolled children" })
  async getMyChildren(@CurrentUser() user: AuthUser) {
    return this.enrollmentService.getParentEnrollments(user.userId);
  }

  /**
   * The parent dashboard's headline figures, rolled up server-side.
   *
   * Declared before `:id/history` so `summary` can never be read as an id.
   *
   * The client used to compute this card itself: filter enrollments on a locally
   * normalised status string, sum `nextInstallmentAmount` across them, and take
   * the minimum `nextDueDate`. That put the busiest number in the app on an
   * aggregate no endpoint validated, and it counted plans whose first payment had
   * never been collected. The server owns it now.
   */
  @SkipThrottle()
  @Get('summary')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER)
  @ApiOperation({
    summary: "The parent dashboard's next-collection and plan totals",
  })
  async getDashboardSummary(@CurrentUser() user: AuthUser) {
    return this.enrollmentService.getParentDashboardSummary(user.userId);
  }

  @SkipThrottle()
  @Get(':id/history')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER)
  @ApiOperation({ summary: 'Get the payment history for an enrollment' })
  async getEnrollmentHistory(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.enrollmentService.getEnrollmentHistory(id, user.userId);
  }

  /**
   * Initiate a first payment via Paystack split. Returns the inline-popup
   * access code + reference; activation happens on the webhook/verify.
   *
   * NOTE: the old manual receipt-based first-payment route (`POST /enrollments`)
   * was removed — first payments must go through Paystack so money is actually
   * collected. There is no offline bypass.
   */
  @Post('initiate-first-payment')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Initiate a first payment via Paystack split' })
  initiateFirstPayment(
    @Body() dto: CreateEnrollmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.enrollmentService.initiateFirstPayment(dto, user.userId);
  }

  @Post('pay-installment')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Submit an installment payment' })
  async payInstallment(
    @Body() dto: CreateInstallmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.enrollmentService.submitInstallmentPayment(
      dto.enrollmentId,
      dto.amountPaid,
      { userId: user.userId, role: user.role, schoolId: user.schoolId },
      dto.receiptUrl,
      dto.idempotencyKey,
    );
  }

  @Post('confirm-first-payment')
  @Roles(UserRole.SCHOOL_OWNER)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Confirm a first payment for an enrollment' })
  async confirmFirstPayment(
    @Body() dto: ConfirmEnrollmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    // School ID comes securely from the authenticated session, never the body.
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }

    return this.enrollmentService.confirmFirstPayment(
      dto.enrollmentId,
      user.schoolId,
      {
        userId: user.userId,
        role: user.role,
      },
    );
  }
}
