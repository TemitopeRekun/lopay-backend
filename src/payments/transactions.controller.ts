import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';
import { SkipThrottle } from '@nestjs/throttler';
import { PaymentTransactionStatus } from '../generated/prisma/client';

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
  @ApiQuery({
    name: 'status',
    required: false,
    enum: PaymentTransactionStatus,
    description:
      'Filter by payment status. Applied in SQL so the history tabs page over the matching set, not over one already-fetched page.',
  })
  async getTransactions(
    @CurrentUser() user: AuthUser,
    @Query('includeReceiptSignedUrls') includeReceiptSignedUrls?: string,
    @Query('receiptType') receiptType?: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    const include = includeReceiptSignedUrls === 'true';
    // An unrecognised status is ignored rather than rejected: it must never
    // silently narrow the ledger to an empty page that reads as "no payments".
    const parsedStatus =
      status && status in PaymentTransactionStatus
        ? (status as PaymentTransactionStatus)
        : undefined;
    return this.paymentService.getHistory(
      user.userId,
      user.role,
      user.schoolId ?? undefined,
      include,
      receiptType ?? 'ALL',
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
      parsedStatus,
    );
  }
}
