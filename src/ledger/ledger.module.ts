import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { EventsModule } from '../events/events.module';
import { AuditModule } from '../audit/audit.module';

/**
 * Owns every money-state transition (Milestone 3). PrismaModule is global, so
 * only the notify/realtime/audit collaborators are imported here. Exported for
 * the thin feature callers (schools / admin / enrollment) to delegate into.
 */
@Module({
  imports: [NotificationsModule, EventsModule, AuditModule],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
