import { Module } from '@nestjs/common';
import { EnrollmentInvitesController } from './enrollment-invites.controller';
import { EnrollmentInvitesService } from './enrollment-invites.service';
import { LedgerModule } from '../ledger/ledger.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EventsModule } from '../events/events.module';

/**
 * Onboarding parents who paid their school before it adopted Lopay.
 *
 * A thin feature module in the Milestone 3 sense: it owns the invite lifecycle
 * (issue, share, revoke, dispute, expire) and delegates every money write to
 * `LedgerModule`, which remains the single owner of balance state.
 *
 * PrismaModule and ConfigModule are global, so only the collaborators this
 * module actually names are imported. The service is exported because the
 * scheduler drives its expiry sweep.
 */
@Module({
  imports: [LedgerModule, AuditModule, NotificationsModule, EventsModule],
  controllers: [EnrollmentInvitesController],
  providers: [EnrollmentInvitesService],
  exports: [EnrollmentInvitesService],
})
export class EnrollmentInvitesModule {}
