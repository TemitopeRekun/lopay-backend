import {
  IsUUID,
  IsNumber,
  Min,
  IsNotEmpty,
  IsString,
  IsOptional,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateInstallmentDto {
  @ApiProperty({ example: 'enrollment-uuid' })
  @IsUUID()
  @IsNotEmpty()
  enrollmentId: string;

  @ApiProperty({ example: 2000, description: 'Amount being paid' })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amountPaid: number;

  @ApiPropertyOptional({
    example: 'receipts/user-uuid/uuid_receipt.jpg',
    description:
      'Receipt storage path returned by POST /documents/receipts/upload-url',
  })
  @IsString()
  @IsOptional()
  receiptUrl?: string;

  @ApiPropertyOptional({
    example: 'b3f1c2a4-9d8e-4f6a-8c2b-1e2d3f4a5b6c',
    description:
      'Client-generated unique key that makes this submission idempotent. ' +
      'Retries with the same key return the original result instead of ' +
      'creating a duplicate payment.',
  })
  @IsString()
  @IsOptional()
  idempotencyKey?: string;
}
