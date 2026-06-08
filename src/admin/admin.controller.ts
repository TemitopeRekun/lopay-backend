import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  Query,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';
import { CreateSchoolDto } from './dto/create.school.dto';
import { CurrentUser } from '../common/decorators/user.decorator';

// Auth + roles are enforced globally (BetterAuthGuard + RolesGuard).
@Controller('admin')
@Roles(UserRole.SUPER_ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  /** Onboard a new school */
  @Post('onboard-school')
  onboardSchool(@Body() dto: CreateSchoolDto) {
    return this.adminService.onboardSchool(dto);
  }

  /** List Nigerian banks for the onboarding settlement-bank dropdown */
  @Get('paystack/banks')
  getBanks() {
    return this.adminService.listBanks();
  }

  /** Verify an account number against a bank code → registered account name */
  @Post('paystack/resolve-account')
  resolveAccount(@Body() body: { accountNumber: string; bankCode: string }) {
    return this.adminService.resolveAccount(body.accountNumber, body.bankCode);
  }

  /** (Re)create a Paystack subaccount for a school missing one */
  @Post('schools/:schoolId/paystack-subaccount')
  createSubaccount(@Param('schoolId') schoolId: string) {
    return this.adminService.createSubaccountForSchool(schoolId);
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
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getSchoolStudents(
      schoolId, className, search,
      page ? parseInt(page, 10) : 1,
      limit ? Math.min(parseInt(limit, 10), 100) : 50,
    );
  }

  /** Settle school share */
  @Post('settle-first-payment/:paymentId')
  settleFirstPayment(
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: any,
  ) {
    return this.adminService.settleFirstPayment(paymentId, {
      userId: user.userId,
      role: user.role,
    });
  }

  /** Reject a first payment */
  @Post('reject-first-payment/:paymentId')
  rejectFirstPayment(
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: any,
  ) {
    return this.adminService.rejectFirstPayment(paymentId, {
      userId: user.userId,
      role: user.role,
    });
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
