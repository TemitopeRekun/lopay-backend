import { InstallmentFrequency } from '../../generated/prisma/client';
import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsEnum,
  IsDate,
  Min,
  IsOptional,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateEnrollmentDto {
  @ApiPropertyOptional({
    example: 'child-uuid',
    description: 'ID of existing child',
  })
  @IsString()
  @IsOptional()
  childId?: string;

  @ApiPropertyOptional({
    example: 'Little Timmy',
    description: 'Name of new child (if childId is not provided)',
  })
  @IsString()
  @IsOptional()
  childName?: string;

  @ApiProperty({ example: 'school-uuid' })
  @IsString()
  @IsNotEmpty()
  schoolId: string;

  @ApiProperty({ example: 'Grade 1' })
  @IsString()
  @IsNotEmpty()
  className: string;

  @ApiProperty({ enum: InstallmentFrequency, example: 'MONTHLY' })
  @Transform(({ value }) => value?.toUpperCase())
  @IsEnum(InstallmentFrequency)
  installmentFrequency: InstallmentFrequency;

  @ApiProperty({
    example: 5000,
    description: 'Amount paid for the first payment',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  firstPaymentPaid: number;

  @ApiProperty({ example: '2023-09-01T00:00:00Z' })
  @Type(() => Date)
  @IsDate()
  termStartDate: Date;

  @ApiProperty({ example: '2023-12-01T00:00:00Z' })
  @Type(() => Date)
  @IsDate()
  termEndDate: Date;

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
