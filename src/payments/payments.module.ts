import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentsController } from './payments.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  providers: [PaymentService, PrismaService],
  controllers: [PaymentsController],
})
export class PaymentsModule {}
