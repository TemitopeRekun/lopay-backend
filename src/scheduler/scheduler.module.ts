import { Module } from '@nestjs/common';
import { DefaulterDetectionService } from './defaulter-detection.service';
import { PaystackReconciliationService } from './paystack-reconciliation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PaystackModule } from '../paystack/paystack.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [PrismaModule, PaystackModule, EnrollmentModule, LedgerModule],
  providers: [DefaulterDetectionService, PaystackReconciliationService],
})
export class SchedulerModule {}
