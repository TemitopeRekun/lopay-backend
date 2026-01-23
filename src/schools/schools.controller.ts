import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { SchoolPaymentsService } from './schools.service';
import { ConfirmPaymentDto } from './dto/confim.payment.dto';
import { MarkDefaultedDto } from './dto/mark-defaulted.dto';

@Controller('school-payments')
export class SchoolPaymentsController {
  constructor(private readonly schoolPaymentsService: SchoolPaymentsService) {}

  /** ✅ List all pending installment payments for this school */
  @Get('pending/:schoolId')
  async getPendingPayments(@Param('schoolId') schoolId: string) {
    return this.schoolPaymentsService.getPendingPayments(schoolId);
  }

  /** ✅ Confirm a single installment payment */
  @Post('confirm')
  async confirmPayment(@Body() dto: ConfirmPaymentDto) {
    return this.schoolPaymentsService.confirmPayment(
      dto.paymentId,
      dto.schoolId,
    );
  }

  /** ✅ Mark an enrollment as defaulted */
  @Post('default')
  async markAsDefaulted(@Body() dto: MarkDefaultedDto) {
    return this.schoolPaymentsService.markEnrollmentAsDefaulted(
      dto.enrollmentId,
      dto.schoolId,
    );
  }
}
