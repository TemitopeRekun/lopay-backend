import { Module } from '@nestjs/common';
import { MigrationInvitesController } from './migration-invites.controller';
import { MigrationInvitesService } from './migration-invites.service';
import { LedgerModule } from '../ledger/ledger.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [LedgerModule, EventsModule],
  controllers: [MigrationInvitesController],
  providers: [MigrationInvitesService],
})
export class MigrationInvitesModule {}