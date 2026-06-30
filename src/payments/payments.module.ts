import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentsController } from './payments.controller';
import { TransactionsController } from './transactions.controller';
import { DocumentsModule } from '../documents/documents.module';

@Module({
  // PrismaModule is @Global, so PrismaService is injectable without a
  // module-local provider. Re-providing it here would create a second
  // PrismaClient (a separate connection pool) — so it is intentionally absent.
  imports: [DocumentsModule],
  providers: [PaymentService],
  controllers: [PaymentsController, TransactionsController],
  exports: [PaymentService],
})
export class PaymentsModule {}
