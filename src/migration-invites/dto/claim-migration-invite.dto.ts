import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ClaimMigrationInviteDto {
  @ApiProperty({ description: 'One-time migration invite token' })
  @IsString()
  @IsNotEmpty()
  token: string;
}