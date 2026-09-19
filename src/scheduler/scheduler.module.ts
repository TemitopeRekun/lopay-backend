import { Module } from '@nestjs/common';
import { DefaulterDetectionService } from './defaulter-detection.service';
import { PaystackReconciliationService } from './paystack-reconciliation.service';
import { ConfirmationStallService } from './confirmation-stall.service';
import { InviteExpiryService } from './invite-expiry.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PaystackModule } from '../paystack/paystack.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { LedgerModule } from '../ledger/ledger.module';
import { EnrollmentInvitesModule } from '../enrollment-invites/enrollment-invites.module';

@Module({
  imports: [
    PrismaModule,
    PaystackModule,
    EnrollmentModule,
    LedgerModule,
    EnrollmentInvitesModule,
  ],
  providers: [
    DefaulterDetectionService,
    PaystackReconciliationService,
    ConfirmationStallService,
    InviteExpiryService,
  ],
})
export class SchedulerModule {}
