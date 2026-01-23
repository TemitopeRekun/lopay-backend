import { Controller, Get, Post, Param } from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

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
