import { Controller, Get, Patch, Param } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';

// Auth enforced globally by BetterAuthGuard.
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: "List the current user's notifications" })
  async getUserNotifications(@CurrentUser() user: AuthUser) {
    return this.notificationsService.getUserNotifications(user.userId);
  }

  // Declared before the parameterised ':id/read' route so 'read-all' is not
  // captured as an :id.
  @Patch('read-all')
  @ApiOperation({
    summary: "Mark all of the current user's notifications as read",
  })
  async markAllAsRead(@CurrentUser() user: AuthUser) {
    return this.notificationsService.markAllAsRead(user.userId);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a single notification as read' })
  async markAsRead(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.notificationsService.markAsRead(id, user.userId);
  }
}
