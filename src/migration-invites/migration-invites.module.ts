import { Module } from '@nestjs/common';
import { MigrationInvitesController } from './migration-invites.controller';
import { MigrationInvitesService } from './migration-invites.service';

@Module({
  controllers: [MigrationInvitesController],
  providers: [MigrationInvitesService],
})
export class MigrationInvitesModule {}