import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { CreateEnrollmentDto } from './dto/create.enrollment.dto';
import { ConfirmEnrollmentDto } from './dto/confirm.enrollment.dto';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/decorators/user.decorator';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';

import { CreateInstallmentDto } from './dto/create.installment.dto';

@Controller('enrollments')
export class EnrollmentController {
  constructor(private readonly enrollmentService: EnrollmentService) {}

  @Get('my-children')
  @Roles(UserRole.PARENT)
  async getMyChildren(@CurrentUser() user: any) {
    return this.enrollmentService.getParentEnrollments(user.sub);
  }

  @Get(':id/history')
  @Roles(UserRole.PARENT)
  async getEnrollmentHistory(@Param('id') id: string, @CurrentUser() user: any) {
    return this.enrollmentService.getEnrollmentHistory(id, user.sub);
  }

  @Post()
  enrollChild(@Body() dto: CreateEnrollmentDto) {
    return this.enrollmentService.enrollChild(dto);
  }

  @Post('pay-installment')
  @Roles(UserRole.PARENT)
  async payInstallment(@Body() dto: CreateInstallmentDto) {
    return this.enrollmentService.submitInstallmentPayment(
      dto.enrollmentId,
      dto.amountPaid,
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
