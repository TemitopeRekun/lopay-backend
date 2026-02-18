import { Controller, Get, UseGuards } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/decorators/user.decorator';
import { SkipThrottle } from '@nestjs/throttler';


@Controller('transactions')
@UseGuards(AuthGuard('jwt'))
export class TransactionsController {
  constructor(private readonly paymentService: PaymentService) {}

  @SkipThrottle()
  @Get()
  async getTransactions(@CurrentUser() user: any) {
    console.log('TransactionsController: getTransactions for user:', user);
    return this.paymentService.getHistory(user.userId, user.role, user.schoolId);
  }
}
