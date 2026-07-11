import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { Throttle } from '@nestjs/throttler';
import type {
  DepositCalculationResult,
  InstallmentCalculationResult,
  ChildPaymentStatus,
} from './payment.service';

// Auth enforced globally by BetterAuthGuard.
@ApiTags('payments')
@ApiBearerAuth()
@Controller('payment')
@Throttle({ default: { ttl: 60000, limit: 30 } })
export class PaymentsController {
  constructor(private readonly paymentService: PaymentService) {}

  /** Calculate full payment structure (New) */
  @Post('calculate-structure')
  @ApiOperation({ summary: 'Calculate the full payment structure' })
  calculateStructure(
    @Body()
    body: {
      schoolId: string;
      totalAmount?: number;
      schoolFees?: number; // Support legacy field
      feeType: string;
      grade: string;
    },
  ) {
    // Prefer totalAmount, fallback to schoolFees
    const amount = body.totalAmount ?? body.schoolFees;

    if (amount === undefined || amount === null) {
      throw new Error('Total amount is required');
    }

    // Ensure we pass a number, even if string was sent
    return this.paymentService.calculatePaymentStructure(Number(amount));
  }

  /** Calculate deposit and platform fee */
  @Post('calculate-deposit')
  @ApiOperation({ summary: 'Calculate the deposit and platform fee' })
  calculateDeposit(
    @Body() body: { schoolFees: number; depositPaid: number },
  ): DepositCalculationResult {
    const { schoolFees, depositPaid } = body;
    return this.paymentService.calculateInitialPayment(schoolFees, depositPaid);
  }

  /** Calculate installments */
  @Post('calculate-installments')
  @ApiOperation({ summary: 'Calculate the installment schedule' })
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
  @ApiOperation({ summary: 'Compute the remaining balance' })
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
  @ApiOperation({ summary: 'Compute the next payment status' })
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
