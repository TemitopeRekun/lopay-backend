import { Module } from '@nestjs/common';
import { DefaulterDetectionService } from './defaulter-detection.service';
import { PaystackReconciliationService } from './paystack-reconciliation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { AuditModule } from '../audit/audit.module';
import { PaystackModule } from '../paystack/paystack.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';

@Module({
  imports: [
    PrismaModule,
    EventsModule,
    AuditModule,
    PaystackModule,
    EnrollmentModule,
  ],
  providers: [DefaulterDetectionService, PaystackReconciliationService],
})
export class SchedulerModule {}
