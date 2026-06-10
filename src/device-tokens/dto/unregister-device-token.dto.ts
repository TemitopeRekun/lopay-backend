import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class UnregisterDeviceTokenDto {
  @ApiProperty({ description: 'FCM device token to unregister' })
  @IsString()
  @IsNotEmpty()
  token: string;
}
