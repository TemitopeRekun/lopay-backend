import { Module } from '@nestjs/common';
import { DefaulterDetectionService } from './defaulter-detection.service';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, EventsModule, AuditModule],
  providers: [DefaulterDetectionService],
})
export class SchedulerModule {}
