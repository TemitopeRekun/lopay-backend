import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  ForbiddenException,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SchoolPaymentsService } from './schools.service';
import { ConfirmPaymentDto } from './dto/confim.payment.dto';
import { MarkDefaultedDto } from './dto/mark-defaulted.dto';
import { ReversePaymentDto } from './dto/reverse.payment.dto';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';
import { SkipThrottle } from '@nestjs/throttler';

import { CreateClassFeeDto } from './dto/create-class-fee.dto';
import { SetClassFeesDto } from './dto/set-class-fees.dto';
import { UpdateSchoolDto } from './dto/update.school.dto';

/** `?take=` → a bounded positive integer, falling back to the caller's default. */
const parseTake = (take: string | undefined, fallback: number): number => {
  if (!take) return fallback;
  const parsed = parseInt(take, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, SchoolPaymentsService.HISTORY_MAX_TAKE);
};

/** `?from=&to=` → a date window, ignoring unparseable values. */
const parseRange = (
  from: string | undefined,
  to: string | undefined,
): { from?: Date; to?: Date } | undefined => {
  const parse = (value?: string): Date | undefined => {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  };
  const parsedFrom = parse(from);
  const parsedTo = parse(to);
  if (!parsedFrom && !parsedTo) return undefined;
  return { from: parsedFrom, to: parsedTo };
};

@ApiTags('school-payments')
@ApiBearerAuth()
@Controller('school-payments')
export class SchoolPaymentsController {
  constructor(private readonly schoolPaymentsService: SchoolPaymentsService) {}

  /** ✅ Create or Update Class Fee */
  @Post('fees')
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({ summary: 'Create or update a class fee' })
  async createClassFee(
    @Body() dto: CreateClassFeeDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.createClassFee(
      user.schoolId,
      dto.className,
      dto.feeAmount,
    );
  }

  /**
   * Publish a whole fee schedule at once (first-run setup, or a bulk revision).
   *
   * Scoped to the caller's own school from the session — a school owns its own
   * fees, and no payload field can redirect the write at another school.
   */
  @Post('fees/bulk')
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({
    summary: "Publish the authenticated owner's whole fee schedule",
  })
  async setClassFees(
    @Body() dto: SetClassFeesDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.setClassFees(user.schoolId, dto.fees);
  }

  /** ✅ Get all Class Fees */
  @Get('fees')
  @Roles(UserRole.SCHOOL_OWNER, UserRole.PARENT) // Parents need to see fees too
  @ApiOperation({ summary: "Get the authenticated owner's school class fees" })
  async getClassFees(@CurrentUser() user: AuthUser) {
    // If user is a school owner, get their school's fees
    if (user.role === UserRole.SCHOOL_OWNER) {
      if (!user.schoolId) {
        throw new ForbiddenException('User is not associated with any school');
      }
      return this.schoolPaymentsService.getClassFees(user.schoolId);
    }

    // If user is a parent, they might be querying fees for a specific school (passed as query param or deduced context)
    // For MVP simplicity, let's assume this endpoint is primarily for the dashboard management.
    // We might need a separate public endpoint or query param for parents to fetch fees of a specific school.
    // Let's defer parent access logic to a dedicated public/enrollment-flow endpoint if needed.
    // Reverting @Roles to SCHOOL_OWNER only for management, and assuming enrollment flow fetches specific fee.

    // Actually, per your requirement: "that school fees would be read only from the parents front end."
    // Parents select a school, then a class. They need to fetch the fee for THAT school's class.
    // So we need a public or parent-accessible endpoint that takes a schoolId.
    throw new ForbiddenException(
      'Use the public endpoint to fetch fees for a specific school',
    );
  }

  /**
   * Get Class Fees for a specific school. Parents need this to pick a class fee
   * before enrolling, so it is open to every authenticated role (class fees are
   * non-sensitive published prices). Roles are listed explicitly rather than left
   * implicit so the access decision is documented and future-proof.
   */
  @SkipThrottle()
  @Get('fees/:schoolId')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get the class fees for a specific school' })
  async getClassFeesForSchool(@Param('schoolId') schoolId: string) {
    return this.schoolPaymentsService.getClassFees(schoolId);
  }

  /**
   * Get a school's bank details. Sensitive — scoped server-side to the owning
   * owner, a super admin, or a parent enrolled at that school (not throttle-skipped
   * so enumeration is rate-limited).
   */
  @Get('bank-details/:schoolId')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: "Get a school's bank details (access-scoped server-side)",
  })
  async getSchoolBankDetails(
    @Param('schoolId') schoolId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.schoolPaymentsService.getSchoolBankDetails(schoolId, {
      userId: user.userId,
      role: user.role,
      schoolId: user.schoolId,
    });
  }

  /** ✅ Update School Bank Details (School Owner Profile) */
  @Put('bank-details')
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({
    summary: "Update the authenticated owner's school bank details",
  })
  async updateSchoolBankDetails(
    @Body() dto: UpdateSchoolDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.updateSchoolBankDetails(
      user.schoolId,
      dto,
    );
  }

  /** ✅ Get School Payment History */
  @SkipThrottle()
  @Get('history')
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({ summary: "Get the school's payment history" })
  async getHistory(
    @CurrentUser() user: AuthUser,
    @Query('includeReceiptSignedUrls') includeReceiptSignedUrls?: string,
    @Query('receiptType') receiptType?: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT',
    @Query('take') take?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    const include = includeReceiptSignedUrls === 'true';
    return this.schoolPaymentsService.getHistory(
      user.schoolId,
      include,
      receiptType ?? 'ALL',
      parseTake(take, 100),
      parseRange(from, to),
    );
  }

  /** ✅ Get School Payment History (All statuses) */
  @SkipThrottle()
  @Get('history/all')
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({
    summary: "Get the school's full payment history (all statuses)",
  })
  async getHistoryAll(
    @CurrentUser() user: AuthUser,
    @Query('includeReceiptSignedUrls') includeReceiptSignedUrls?: string,
    @Query('receiptType') receiptType?: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT',
    @Query('take') take?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    const include = includeReceiptSignedUrls === 'true';
    return this.schoolPaymentsService.getHistory(
      user.schoolId,
      include,
      receiptType ?? 'ALL',
      parseTake(take, 100),
      parseRange(from, to),
    );
  }

  /** ✅ Get School Dashboard Stats */
  @SkipThrottle()
  @Get('stats')
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({ summary: 'Get the school dashboard stats' })
  async getDashboardStats(@CurrentUser() user: AuthUser) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.getDashboardStats(user.schoolId);
  }

  /** ✅ Get All Students (Optional Class Filter, Search & Pagination) */
  @SkipThrottle()
  @Get('students')
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({
    summary: "List the school's students (class filter, search, pagination)",
  })
  async getStudents(
    @CurrentUser() user: AuthUser,
    @Query('className') className?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.getStudents(
      user.schoolId,
      className,
      search,
      page ? parseInt(page, 10) : 1,
      limit ? Math.min(parseInt(limit, 10), 200) : 50,
    );
  }

  /** ✅ List all pending installment payments for this school */
  @SkipThrottle()
  @Get('pending')
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({ summary: "List the school's pending installment payments" })
  async getPendingPayments(
    @CurrentUser() user: AuthUser,
    @Query('includeReceiptSignedUrls') includeReceiptSignedUrls?: string,
    @Query('receiptType') receiptType?: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT',
    @Query('paymentType') paymentType?: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT',
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    const include = includeReceiptSignedUrls === 'true';
    return this.schoolPaymentsService.getPendingPayments(
      user.schoolId,
      include,
      receiptType ?? 'ALL',
      100,
      paymentType ?? 'INSTALLMENT',
    );
  }

  /** ✅ Confirm a single installment payment */
  @Post('confirm')
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({ summary: 'Confirm a single installment payment' })
  async confirmPayment(
    @Body() dto: ConfirmPaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.confirmPayment(
      dto.paymentId,
      user.schoolId,
      {
        userId: user.userId,
        role: user.role,
      },
    );
  }

  /** ✅ Reject a single installment payment */
  @Post('reject')
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({ summary: 'Reject a single installment payment' })
  async rejectPayment(
    @Body() dto: ConfirmPaymentDto, // Reusing DTO as it only needs paymentId
    @CurrentUser() user: AuthUser,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.rejectPayment(
      dto.paymentId,
      user.schoolId,
      {
        userId: user.userId,
        role: user.role,
      },
    );
  }

  /** ✅ Mark an enrollment as defaulted */
  @Post('default')
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({ summary: 'Mark an enrollment as defaulted' })
  async markAsDefaulted(
    @Body() dto: MarkDefaultedDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.markEnrollmentAsDefaulted(
      dto.enrollmentId,
      user.schoolId,
      { userId: user.userId, role: user.role },
    );
  }

  /** ✅ Reverse a previously-confirmed installment payment (auditable undo) */
  @Post('reverse')
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({
    summary: 'Reverse a previously-confirmed installment payment',
  })
  async reversePayment(
    @Body() dto: ReversePaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.reversePayment(
      dto.paymentId,
      user.schoolId,
      { userId: user.userId, role: user.role },
      dto.reason,
    );
  }
}
