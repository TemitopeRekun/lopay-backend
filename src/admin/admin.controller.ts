import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { Roles } from '../auth/roles.decorator';
import { UserRole, PaymentTransactionStatus } from '../generated/prisma/client';
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

  /**
   * Payout readiness per school, VERIFIED against Paystack rather than read from
   * our own `paystackSubaccountActive` column — which only records that a create
   * call once succeeded and so cannot see a subaccount belonging to a different
   * integration (e.g. one left behind in test mode).
   */
  @Get('schools/payout-status')
  @ApiOperation({
    summary: 'Per-school payout readiness, verified against Paystack',
  })
  getSchoolsPayoutStatus() {
    return this.adminService.getSchoolsPayoutStatus();
  }

  /** Repair a school's Paystack payout account. Idempotent — safe to press twice. */
  @Post('schools/:schoolId/paystack-subaccount')
  @ApiOperation({
    summary:
      'Create or repair a school’s Paystack subaccount (idempotent: keeps an existing one that is still valid on this integration)',
  })
  createSubaccount(@Param('schoolId') schoolId: string) {
    return this.adminService.createSubaccountForSchool(schoolId);
  }

  /** View pending first payments (paginated, optionally one school) */
  @Get('pending-first-payments')
  @ApiOperation({ summary: 'List pending first payments (paginated)' })
  @ApiQuery({
    name: 'schoolId',
    required: false,
    description:
      "Narrow to one school. Backs the dashboard's per-school drill-in, which " +
      'used to switch the admin into a school-owner acting role and land on an ' +
      'unfiltered platform-wide list.',
  })
  getPendingFirstPayments(
    @Query('includeReceiptSignedUrls') includeReceiptSignedUrls?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('schoolId') schoolId?: string,
  ) {
    const include = includeReceiptSignedUrls === 'true';
    return this.adminService.getPendingFirstPayments(
      include,
      page,
      limit,
      schoolId,
    );
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
  @ApiQuery({
    name: 'status',
    required: false,
    enum: PaymentTransactionStatus,
    description:
      'Filter by payment status. Applied in SQL so the admin history tabs page over the matching set, not over one already-fetched page.',
  })
  getTransactions(
    @Query('includeReceiptSignedUrls') includeReceiptSignedUrls?: string,
    @Query('receiptType') receiptType?: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    const include = includeReceiptSignedUrls === 'true';
    // Ignore an unrecognised status rather than 400-ing: an unknown value must
    // never silently narrow the ledger to an empty page that reads as "none".
    const parsedStatus =
      status && status in PaymentTransactionStatus
        ? (status as PaymentTransactionStatus)
        : undefined;
    return this.adminService.getTransactions(
      include,
      receiptType ?? 'ALL',
      page,
      limit,
      parsedStatus,
    );
  }

  /** Global student summary */
  @Get('students/summary')
  @ApiOperation({ summary: 'Get global student summary' })
  getStudentsSummary() {
    return this.adminService.getStudentsSummary();
  }

  /**
   * Collections breakdown per school — backs the outstanding / overdue /
   * students tabs of the admin breakdown screen from one payload.
   */
  @Get('breakdown')
  @ApiOperation({
    summary:
      'Per-school collections breakdown (outstanding, overdue, student counts)',
  })
  getBreakdownSummary() {
    return this.adminService.getBreakdownSummary();
  }

  /** Per-student breakdown for one school, for a single tab (paginated). */
  @Get('schools/:schoolId/breakdown')
  @ApiOperation({
    summary: 'Per-student collections breakdown for one school (paginated)',
  })
  @ApiQuery({
    name: 'tab',
    required: false,
    enum: ['students', 'outstanding', 'overdue'],
    description:
      'Which view to return. Applied server-side because overdue ranks on a derived figure.',
  })
  getSchoolBreakdown(
    @Param('schoolId') schoolId: string,
    @Query('tab') tab?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const resolved =
      tab === 'outstanding' || tab === 'overdue' ? tab : 'students';
    return this.adminService.getSchoolBreakdown(
      schoolId,
      resolved,
      page,
      limit,
    );
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
  @ApiQuery({
    name: 'range',
    required: false,
    enum: ['monthly', 'weekly'],
    description: 'Bucket size for revenueSeries. Defaults to monthly.',
  })
  getOverview(@Query('range') range?: string) {
    return this.adminService.getOverview(
      range === 'weekly' ? 'weekly' : 'monthly',
    );
  }
}
