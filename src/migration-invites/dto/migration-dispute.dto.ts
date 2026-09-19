import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class MigrationDisputeDto {
  @ApiProperty({ description: 'One-time migration invite token' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ example: 'The school says 25,000 but I paid 35,000' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}