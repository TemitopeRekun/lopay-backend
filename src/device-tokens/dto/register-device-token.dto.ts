import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsIn } from 'class-validator';

export class RegisterDeviceTokenDto {
  @ApiProperty({ description: 'FCM device token' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ enum: ['web', 'android', 'ios'] })
  @IsString()
  @IsIn(['web', 'android', 'ios'])
  platform: 'web' | 'android' | 'ios';
}
