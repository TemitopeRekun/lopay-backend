import { Controller, Get, Patch, Param } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';

// Auth enforced globally by BetterAuthGuard.
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async getUserNotifications(@CurrentUser() user: AuthUser) {
    return this.notificationsService.getUserNotifications(user.userId);
  }

  // Declared before the parameterised ':id/read' route so 'read-all' is not
  // captured as an :id.
  @Patch('read-all')
  async markAllAsRead(@CurrentUser() user: AuthUser) {
    return this.notificationsService.markAllAsRead(user.userId);
  }

  @Patch(':id/read')
  async markAsRead(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.notificationsService.markAsRead(id, user.userId);
  }
}
