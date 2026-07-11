import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';
import { SkipThrottle } from '@nestjs/throttler';

// Auth enforced globally by BetterAuthGuard.
@ApiTags('transactions')
@ApiBearerAuth()
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly paymentService: PaymentService) {}

  @SkipThrottle()
  @Get()
  @ApiOperation({
    summary: "List the current user's transaction history (paginated)",
  })
  async getTransactions(
    @CurrentUser() user: AuthUser,
    @Query('includeReceiptSignedUrls') includeReceiptSignedUrls?: string,
    @Query('receiptType') receiptType?: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const include = includeReceiptSignedUrls === 'true';
    return this.paymentService.getHistory(
      user.userId,
      user.role,
      user.schoolId ?? undefined,
      include,
      receiptType ?? 'ALL',
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }
}
