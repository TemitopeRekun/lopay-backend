import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { CreateEnrollmentDto } from './dto/create.enrollment.dto';
import { ConfirmEnrollmentDto } from './dto/confirm.enrollment.dto';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/decorators/user.decorator';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../../generated/client/client';

import { CreateInstallmentDto } from './dto/create.installment.dto';

@Controller('enrollments')
@UseGuards(AuthGuard('jwt'))
export class EnrollmentController {
  constructor(private readonly enrollmentService: EnrollmentService) {}

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
