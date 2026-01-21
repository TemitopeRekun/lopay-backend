import { Controller, Post, Body } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { CreateEnrollmentDto } from './dto/create.enrollment.dto';
import { ConfirmEnrollmentDto } from './dto/confirm.enrollment.dto';

@Controller('enrollments')
export class EnrollmentController {
  constructor(private readonly enrollmentService: EnrollmentService) {}

  @Post()
  enrollChild(@Body() dto: CreateEnrollmentDto) {
    return this.enrollmentService.enrollChild(dto);
  }

  @Post('confirm-first-payment')
  async confirmFirstPayment(@Body() dto: ConfirmEnrollmentDto) {
    // ⚠️ TEMP: schoolId will come from auth later
    const schoolId = 'SCHOOL_ID_FROM_AUTH';

    return this.enrollmentService.confirmFirstPayment(
      dto.enrollmentId,
      schoolId,
    );
  }
}
