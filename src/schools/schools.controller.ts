import { Controller, Get, Post, Body, Param, UseGuards, ForbiddenException } from '@nestjs/common';
import { SchoolPaymentsService } from './schools.service';
import { ConfirmPaymentDto } from './dto/confim.payment.dto';
import { MarkDefaultedDto } from './dto/mark-defaulted.dto';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../../generated/client/client';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('school-payments')
export class SchoolPaymentsController {
  constructor(private readonly schoolPaymentsService: SchoolPaymentsService) {}

  /** ✅ List all pending installment payments for this school */
  @Get('pending')
  @Roles(UserRole.SCHOOL_OWNER)
  async getPendingPayments(@CurrentUser() user: any) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.getPendingPayments(user.schoolId);
  }

  /** ✅ Confirm a single installment payment */
  @Post('confirm')
  @Roles(UserRole.SCHOOL_OWNER)
  async confirmPayment(@Body() dto: ConfirmPaymentDto, @CurrentUser() user: any) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.confirmPayment(dto.paymentId, user.schoolId);
  }

  /** ✅ Mark an enrollment as defaulted */
  @Post('default')
  @Roles(UserRole.SCHOOL_OWNER)
  async markAsDefaulted(@Body() dto: MarkDefaultedDto, @CurrentUser() user: any) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.markEnrollmentAsDefaulted(
      dto.enrollmentId,
      user.schoolId,
    );
  }
}
