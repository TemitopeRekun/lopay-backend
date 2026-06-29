import { Body, Controller, Delete, Post } from '@nestjs/common';
import { DeviceTokensService } from './device-tokens.service';
import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';
import { UnregisterDeviceTokenDto } from './dto/unregister-device-token.dto';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';

@Controller('device-tokens')
export class DeviceTokensController {
  constructor(private readonly deviceTokensService: DeviceTokensService) {}

  @Post()
  async register(
    @Body() dto: RegisterDeviceTokenDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deviceTokensService.register(user.userId, dto);
  }

  @Delete()
  async unregister(
    @Body() dto: UnregisterDeviceTokenDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deviceTokensService.unregister(user.userId, dto.token);
  }
}
