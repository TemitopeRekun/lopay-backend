import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentsController } from './payments.controller';
import { TransactionsController } from './transactions.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  providers: [PaymentService, PrismaService],
  controllers: [PaymentsController, TransactionsController],
  exports: [PaymentService],
})
export class PaymentsModule {}
