import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { CreateEnrollmentDto } from './dto/create.enrollment.dto';
import { ConfirmEnrollmentDto } from './dto/confirm.enrollment.dto';
import { CurrentUser } from '../common/decorators/user.decorator';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';
import { SkipThrottle } from '@nestjs/throttler';

import { CreateInstallmentDto } from './dto/create.installment.dto';

@Controller('enrollments')
export class EnrollmentController {
  constructor(private readonly enrollmentService: EnrollmentService) {}

  @SkipThrottle()
  @Get('my-children')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER)
  async getMyChildren(@CurrentUser() user: any) {
    console.log('EnrollmentController: getMyChildren for user:', user);
    return this.enrollmentService.getParentEnrollments(user.userId);
  }

  @SkipThrottle()
  @Get(':id/history')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER)
  async getEnrollmentHistory(@Param('id') id: string, @CurrentUser() user: any) {
    return this.enrollmentService.getEnrollmentHistory(id, user.userId);
  }

  @Post()
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER)
  enrollChild(@Body() dto: CreateEnrollmentDto, @CurrentUser() user: any) {
    return this.enrollmentService.enrollChild(dto, user.userId);
  }

  @Post('pay-installment')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER)
  async payInstallment(@Body() dto: CreateInstallmentDto) {
    return this.enrollmentService.submitInstallmentPayment(
      dto.enrollmentId,
      dto.amountPaid,
      dto.receiptUrl,
    );
  }

  @Post('confirm-first-payment')
  @Roles(UserRole.SCHOOL_OWNER)
  async confirmFirstPayment(
    @Body() dto: ConfirmEnrollmentDto,
    @CurrentUser() user: any,
  ) {
    // School ID comes securely from the JWT token
    const schoolId = user.schoolId;

    return this.enrollmentService.confirmFirstPayment(
      dto.enrollmentId,
      schoolId,
    );
  }
}
