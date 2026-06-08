import { Controller, Get, Query } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { CurrentUser } from '../common/decorators/user.decorator';
import { SkipThrottle } from '@nestjs/throttler';

// Auth enforced globally by BetterAuthGuard.
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly paymentService: PaymentService) {}

  @SkipThrottle()
  @Get()
  async getTransactions(
    @CurrentUser() user: any,
    @Query('includeReceiptSignedUrls') includeReceiptSignedUrls?: string,
    @Query('receiptType') receiptType?: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT',
  ) {
    const include = includeReceiptSignedUrls === 'true';
    return this.paymentService.getHistory(
      user.userId,
      user.role,
      user.schoolId,
      include,
      receiptType ?? 'ALL',
    );
  }
}
