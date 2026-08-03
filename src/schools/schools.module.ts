import { Module } from '@nestjs/common';
import { SchoolPaymentsController } from './schools.controller';
import { SchoolsManagementController } from './schools.management.controller';
import { SchoolPaymentsService } from './schools.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DocumentsModule } from '../documents/documents.module';
import { EventsModule } from '../events/events.module';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { SchoolOnboardingModule } from '../school-onboarding/school-onboarding.module';
import { PaystackModule } from '../paystack/paystack.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    DocumentsModule,
    EventsModule,
    AuditModule,
    LedgerModule,
    SchoolOnboardingModule,
    PaystackModule,
  ],
  controllers: [SchoolPaymentsController, SchoolsManagementController],
  providers: [SchoolPaymentsService],
})
export class SchoolsModule {}
