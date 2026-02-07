import { InstallmentFrequency } from '../../generated/prisma/client';
import { IsString, IsNotEmpty, IsNumber, IsEnum, IsDate, Min, IsOptional } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateEnrollmentDto {
  @ApiPropertyOptional({ example: 'child-uuid', description: 'ID of existing child' })
  @IsString()
  @IsOptional()
  childId?: string;

  @ApiPropertyOptional({ example: 'Little Timmy', description: 'Name of new child (if childId is not provided)' })
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

  @ApiProperty({ example: 5000, description: 'Amount paid for the first payment' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  firstPaymentPaid: number;

  @ApiProperty({ example: '2023-09-01T00:00:00Z' })
  @Type(() => Date)
  @IsDate()
  termStartDate: Date;

  @ApiProperty({ example: '2023-12-01T00:00:00Z' })
  @Type(() => Date)
  @IsDate()
  termEndDate: Date;

  @ApiPropertyOptional({ example: 'https://firebase-storage...', description: 'Proof of payment URL' })
  @IsString()
  @IsOptional()
  receiptUrl?: string;
}
