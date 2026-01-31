import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../../generated/client/client';
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
  getPendingFirstPayments() {
    return this.adminService.getPendingFirstPayments();
  }

  /** Settle school share */
  @Post('settle-first-payment/:paymentId')
  settleFirstPayment(@Param('paymentId') paymentId: string) {
    return this.adminService.settleFirstPayment(paymentId);
  }

  /** Platform revenue */
  @Get('revenue')
  getRevenue() {
    return this.adminService.getPlatformRevenue();
  }
}
