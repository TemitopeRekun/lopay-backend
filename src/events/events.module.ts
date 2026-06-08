import { Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway';

/**
 * Self-contained realtime module. The gateway validates socket handshake tokens
 * against the Better Auth session (AuthService is provided globally), so no JWT
 * module is needed. Exports EventsGateway for feature services to emit.
 */
@Module({
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
