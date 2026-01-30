import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { CreateEnrollmentDto } from './dto/create.enrollment.dto';
import { ConfirmEnrollmentDto } from './dto/confirm.enrollment.dto';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('enrollments')
@UseGuards(AuthGuard('jwt'))
export class EnrollmentController {
  constructor(private readonly enrollmentService: EnrollmentService) {}

  @Post()
  enrollChild(@Body() dto: CreateEnrollmentDto) {
    return this.enrollmentService.enrollChild(dto);
  }

  @Post('confirm-first-payment')
  async confirmFirstPayment(
    @Body() dto: ConfirmEnrollmentDto,
    @CurrentUser() user: any,
  ) {
    // School ID comes securely from the JWT token
    const schoolId = user.schoolId;

   
  }
}
