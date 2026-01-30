import { Controller, Post, Body, Param, Get, UseGuards } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { AuthGuard } from '@nestjs/passport';
import type {
  DepositCalculationResult,
  InstallmentCalculationResult,
  ChildPaymentStatus,
} from './payment.service';

@Controller('payment')
@UseGuards(AuthGuard('jwt'))
export class PaymentsController {
  constructor(private readonly paymentService: PaymentService) {}

  /** Calculate deposit and platform fee */
  @Post('calculate-deposit')
  calculateDeposit(
    @Body() body: { schoolFees: number; depositPaid: number },
  ): DepositCalculationResult {
    const { schoolFees, depositPaid } = body;
    return this.paymentService.calculateInitialPayment(schoolFees, depositPaid);
  }

  /** Calculate installments */
  @Post('calculate-installments')
  calculateInstallments(
    @Body() body: { remainingBalance: number; plan: 'WEEKLY' | 'MONTHLY' },
  ): InstallmentCalculationResult {
    return this.paymentService.calculateInstallments(
      body.remainingBalance,
      body.plan,
    );
  }

  /** Update remaining balance */
  @Post('update-balance')
  updateBalance(
    @Body()
    body: {
      schoolFees: number;
      depositPaid: number;
      installmentsPaid: number;
    },
  ): { remainingBalance: number } {
    const remainingBalance = this.paymentService.updateRemainingBalance(
      body.schoolFees,
      body.depositPaid,
      body.installmentsPaid,
    );
    return { remainingBalance };
  }

  /** Update status */
  @Post('update-status')
  updateStatus(
    @Body()
    body: {
      currentStatus: ChildPaymentStatus;
      depositPaid: number;
      depositConfirmedBySchool: boolean;
      remainingBalance: number;
      isOverdue: boolean;
    },
  ): { newStatus: ChildPaymentStatus } {
    const newStatus = this.paymentService.getNextStatus(
      body.currentStatus,
      body.depositPaid,
      body.depositConfirmedBySchool,
      body.remainingBalance,
      body.isOverdue,
    );
    return { newStatus };
  }
}
