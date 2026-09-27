import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { OAuthHandoffController } from './oauth-handoff.controller';

/**
 * The redirect routes that carry a Google sign-in between two different sites.
 *
 * Controller-only: every decision worth testing lives either in
 * `oauth-handoff.ts` (pure, swept exhaustively) or inside Better Auth itself,
 * so there is no service layer for this module to own.
 *
 * `AuthService` comes from the globally-registered `BetterAuthModule`
 * (`app.module.ts` passes `isGlobal: true`), and PrismaModule and ConfigModule
 * are global too, so `NotificationsModule` is the only collaborator this has to
 * name — it is how the owner of an account learns that Google was attached to
 * it. See `OAuthHandoffController.announceFirstGoogleLink`.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [OAuthHandoffController],
})
export class OAuthHandoffModule {}
