import { Body, Controller, Delete, Post } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { DeviceTokensService } from './device-tokens.service';
import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';
import { UnregisterDeviceTokenDto } from './dto/unregister-device-token.dto';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';

@ApiTags('device-tokens')
@ApiBearerAuth()
@Controller('device-tokens')
export class DeviceTokensController {
  constructor(private readonly deviceTokensService: DeviceTokensService) {}

  @Post()
  @ApiOperation({ summary: 'Register a device push-notification token' })
  async register(
    @Body() dto: RegisterDeviceTokenDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deviceTokensService.register(user.userId, dto);
  }

  @Delete()
  @ApiOperation({ summary: 'Unregister a device push-notification token' })
  async unregister(
    @Body() dto: UnregisterDeviceTokenDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deviceTokensService.unregister(user.userId, dto.token);
  }
}
