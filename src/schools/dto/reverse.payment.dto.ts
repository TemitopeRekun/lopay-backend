import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReversePaymentDto {
  @ApiProperty({ example: 'payment-uuid' })
  @IsString()
  @IsNotEmpty()
  paymentId: string;

  @ApiPropertyOptional({
    example: 'Confirmed in error — funds not actually received.',
    description: 'Why the confirmation is being reversed (stored in the audit log).',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}
