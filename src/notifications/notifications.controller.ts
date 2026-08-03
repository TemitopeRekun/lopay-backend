import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';
import { BroadcastNotificationDto } from './dto/broadcast.notification.dto';

// Auth enforced globally by BetterAuthGuard.
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /** Platform announcement to every parent (admin only). */
  @Post('broadcast')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Broadcast an announcement to all parents' })
  async broadcast(@Body() dto: BroadcastNotificationDto) {
    return this.notificationsService.broadcastToParents(
      dto.title,
      dto.message,
      dto.link,
    );
  }

  @Get()
  @ApiOperation({
    summary: "List the current user's notifications (bounded, newest first)",
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Rows to return (default 100, max 200).',
  })
  async getUserNotifications(
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
  ) {
    return this.notificationsService.getUserNotifications(
      user.userId,
      limit ? Number(limit) : undefined,
    );
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
