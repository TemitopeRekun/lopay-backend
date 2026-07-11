import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';
import { CreateSchoolDto } from './dto/create.school.dto';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';

// Auth + roles are enforced globally (BetterAuthGuard + RolesGuard).
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@Roles(UserRole.SUPER_ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  /** Onboard a new school */
  @Post('onboard-school')
  @ApiOperation({ summary: 'Onboard a new school' })
  onboardSchool(@Body() dto: CreateSchoolDto) {
    return this.adminService.onboardSchool(dto);
  }

  /** List Nigerian banks for the onboarding settlement-bank dropdown */
  @Get('paystack/banks')
  @ApiOperation({
    summary: 'List Nigerian banks for the settlement-bank dropdown',
  })
  getBanks() {
    return this.adminService.listBanks();
  }

  /** Verify an account number against a bank code → registered account name */
  @Post('paystack/resolve-account')
  @ApiOperation({
    summary:
      'Resolve an account number + bank code to the registered account name',
  })
  resolveAccount(@Body() body: { accountNumber: string; bankCode: string }) {
    return this.adminService.resolveAccount(body.accountNumber, body.bankCode);
  }

  /** (Re)create a Paystack subaccount for a school missing one */
  @Post('schools/:schoolId/paystack-subaccount')
  @ApiOperation({
    summary: 'Create a Paystack subaccount for a school missing one',
  })
  createSubaccount(@Param('schoolId') schoolId: string) {
    return this.adminService.createSubaccountForSchool(schoolId);
  }

  /** View pending first payments (paginated) */
  @Get('pending-first-payments')
  @ApiOperation({ summary: 'List pending first payments (paginated)' })
  getPendingFirstPayments(
    @Query('includeReceiptSignedUrls') includeReceiptSignedUrls?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const include = includeReceiptSignedUrls === 'true';
    return this.adminService.getPendingFirstPayments(include, page, limit);
  }

  /** View pending installment payments across schools (paginated, read-only) */
  @Get('pending-installments')
  @ApiOperation({
    summary: 'List pending installment payments across all schools (paginated)',
  })
  getPendingInstallments(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getPendingInstallments(page, limit);
  }

  /** View students/enrollments for a specific school (paginated, read-only) */
  @Get('schools/:schoolId/students')
  @ApiOperation({
    summary: 'List students/enrollments for a specific school (paginated)',
  })
  getSchoolStudents(
    @Param('schoolId') schoolId: string,
    @Query('className') className?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getSchoolStudents(
      schoolId,
      className,
      search,
      page,
      limit,
    );
  }

  /** Settle school share */
  @Post('settle-first-payment/:paymentId')
  @ApiOperation({
    summary: 'Settle a first payment (release the school share)',
  })
  settleFirstPayment(
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.settleFirstPayment(paymentId, {
      userId: user.userId,
      role: user.role,
    });
  }

  /** Reject a first payment */
  @Post('reject-first-payment/:paymentId')
  @ApiOperation({ summary: 'Reject a first payment' })
  rejectFirstPayment(
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.rejectFirstPayment(paymentId, {
      userId: user.userId,
      role: user.role,
    });
  }

  /** Platform revenue */
  @Get('revenue')
  @ApiOperation({ summary: 'Get platform revenue' })
  getRevenue() {
    return this.adminService.getPlatformRevenue();
  }

  /** Global transactions across all schools (paginated) */
  @Get('transactions')
  @ApiOperation({
    summary: 'List global transactions across all schools (paginated)',
  })
  getTransactions(
    @Query('includeReceiptSignedUrls') includeReceiptSignedUrls?: string,
    @Query('receiptType') receiptType?: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const include = includeReceiptSignedUrls === 'true';
    return this.adminService.getTransactions(
      include,
      receiptType ?? 'ALL',
      page,
      limit,
    );
  }

  /** Global student summary */
  @Get('students/summary')
  @ApiOperation({ summary: 'Get global student summary' })
  getStudentsSummary() {
    return this.adminService.getStudentsSummary();
  }

  /** Optional: per-school summary */
  @Get('schools/summary')
  @ApiOperation({ summary: 'Get per-school summary' })
  getSchoolsSummary() {
    return this.adminService.getSchoolsSummary();
  }

  /** Admin overview (single-call dashboard payload) */
  @Get('overview')
  @ApiOperation({
    summary: 'Get admin overview (single-call dashboard payload)',
  })
  getOverview() {
    return this.adminService.getOverview();
  }
}
