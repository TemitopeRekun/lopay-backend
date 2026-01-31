import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ForbiddenException,
  Query,
} from '@nestjs/common';
import { SchoolPaymentsService } from './schools.service';
import { ConfirmPaymentDto } from './dto/confim.payment.dto';
import { MarkDefaultedDto } from './dto/mark-defaulted.dto';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../../generated/client/client';
import { CurrentUser } from '../common/decorators/user.decorator';

import { CreateClassFeeDto } from './dto/create-class-fee.dto';

@Controller('school-payments')
export class SchoolPaymentsController {
  constructor(private readonly schoolPaymentsService: SchoolPaymentsService) {}

  /** ✅ Create or Update Class Fee */
  @Post('fees')
  @Roles(UserRole.SCHOOL_OWNER)
  async createClassFee(
    @Body() dto: CreateClassFeeDto,
    @CurrentUser() user: any,
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

  /** ✅ Get all Class Fees */
  @Get('fees')
  @Roles(UserRole.SCHOOL_OWNER, UserRole.PARENT) // Parents need to see fees too
  async getClassFees(@CurrentUser() user: any) {
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

  /** ✅ Get Class Fees for a specific school (Public/Parent access) */
  @Get('fees/:schoolId')
  async getClassFeesForSchool(@Param('schoolId') schoolId: string) {
    return this.schoolPaymentsService.getClassFees(schoolId);
  }

  /** ✅ Get School Dashboard Stats */
  @Get('stats')
  @Roles(UserRole.SCHOOL_OWNER)
  async getDashboardStats(@CurrentUser() user: any) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.getDashboardStats(user.schoolId);
  }

  /** ✅ Get All Students (Optional Class Filter & Search) */
  @Get('students')
  @Roles(UserRole.SCHOOL_OWNER)
  async getStudents(
    @CurrentUser() user: any,
    @Query('className') className?: string,
    @Query('search') search?: string,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.getStudents(user.schoolId, className, search);
  }

  /** ✅ List all pending installment payments for this school */
  @Get('pending')
  @Roles(UserRole.SCHOOL_OWNER)
  async getPendingPayments(@CurrentUser() user: any) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.getPendingPayments(user.schoolId);
  }

  /** ✅ Confirm a single installment payment */
  @Post('confirm')
  @Roles(UserRole.SCHOOL_OWNER)
  async confirmPayment(
    @Body() dto: ConfirmPaymentDto,
    @CurrentUser() user: any,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.confirmPayment(
      dto.paymentId,
      user.schoolId,
    );
  }

  /** ✅ Mark an enrollment as defaulted */
  @Post('default')
  @Roles(UserRole.SCHOOL_OWNER)
  async markAsDefaulted(
    @Body() dto: MarkDefaultedDto,
    @CurrentUser() user: any,
  ) {
    if (!user.schoolId) {
      throw new ForbiddenException('User is not associated with any school');
    }
    return this.schoolPaymentsService.markEnrollmentAsDefaulted(
      dto.enrollmentId,
      user.schoolId,
    );
  }
}
