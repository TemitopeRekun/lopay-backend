import { Controller, Get, Post, Param, Body, UseGuards, Query } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';
import { CreateSchoolDto } from './dto/create.school.dto';

@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  /** Onboard a new school */
  @Post('onboard-school')
  onboardSchool(@Body() dto: CreateSchoolDto) {
    return this.adminService.onboardSchool(dto);
  }

  /** View pending first payments */
  @Get('pending-first-payments')
  getPendingFirstPayments(
    @Query('includeReceiptSignedUrls') includeReceiptSignedUrls?: string,
  ) {
    const include = includeReceiptSignedUrls === 'true';
    return this.adminService.getPendingFirstPayments(include);
  }

  /** View all pending installment payments across schools (read-only) */
  @Get('pending-installments')
  getPendingInstallments() {
    return this.adminService.getPendingInstallments();
  }

  /** View students/enrollments for a specific school (read-only) */
  @Get('schools/:schoolId/students')
  getSchoolStudents(
    @Param('schoolId') schoolId: string,
    @Query('className') className?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.getSchoolStudents(schoolId, className, search);
  }

  /** Settle school share */
  @Post('settle-first-payment/:paymentId')
  settleFirstPayment(@Param('paymentId') paymentId: string) {
    return this.adminService.settleFirstPayment(paymentId);
  }

  /** Reject a first payment */
  @Post('reject-first-payment/:paymentId')
  rejectFirstPayment(@Param('paymentId') paymentId: string) {
    return this.adminService.rejectFirstPayment(paymentId);
  }

  /** Platform revenue */
  @Get('revenue')
  getRevenue() {
    return this.adminService.getPlatformRevenue();
  }

  /** Global transactions across all schools */
  @Get('transactions')
  getTransactions(
    @Query('includeReceiptSignedUrls') includeReceiptSignedUrls?: string,
    @Query('receiptType') receiptType?: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT',
  ) {
    const include = includeReceiptSignedUrls === 'true';
    return this.adminService.getTransactions(include, receiptType ?? 'ALL');
  }

  /** Global student summary */
  @Get('students/summary')
  getStudentsSummary() {
    return this.adminService.getStudentsSummary();
  }

  /** Optional: per-school summary */
  @Get('schools/summary')
  getSchoolsSummary() {
    return this.adminService.getSchoolsSummary();
  }

  /** Admin overview (single-call dashboard payload) */
  @Get('overview')
  getOverview() {
    return this.adminService.getOverview();
  }
}
