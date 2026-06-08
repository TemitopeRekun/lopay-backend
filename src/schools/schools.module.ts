import { Module } from '@nestjs/common';
import { SchoolPaymentsController } from './schools.controller';
import { SchoolsManagementController } from './schools.management.controller';
import { SchoolPaymentsService } from './schools.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DocumentsModule } from '../documents/documents.module';
import { EventsModule } from '../events/events.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    DocumentsModule,
    EventsModule,
    AuditModule,
  ],
  controllers: [SchoolPaymentsController, SchoolsManagementController],
  providers: [SchoolPaymentsService],
})
export class SchoolsModule {}
