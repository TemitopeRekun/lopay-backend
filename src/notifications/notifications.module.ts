import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { EventsModule } from '../events/events.module';
import { DeviceTokensModule } from '../device-tokens/device-tokens.module';

@Module({
  imports: [EventsModule, DeviceTokensModule],
  providers: [NotificationsService],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
