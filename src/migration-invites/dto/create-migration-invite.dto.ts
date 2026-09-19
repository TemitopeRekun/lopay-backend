import { InstallmentFrequency } from '../../generated/prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import { IsDate, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateMigrationInviteDto {
  @ApiProperty({ example: 'Ada Lovelace' })
  @IsString()
  @IsNotEmpty()
  studentName: string;

  @ApiProperty({ example: 'Basic 1' })
  @IsString()
  @IsNotEmpty()
  className: string;

  @ApiProperty({ example: 27500, description: 'Amount already paid in naira' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amountPaid: number;

  @ApiProperty({ example: '+2348012345678', description: 'Parent WhatsApp number' })
  @IsString()
  @IsNotEmpty()
  parentPhone: string;

  @ApiProperty({ enum: InstallmentFrequency })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.toUpperCase() : value)
  @IsEnum(InstallmentFrequency)
  installmentFrequency: InstallmentFrequency;

  @ApiProperty({ example: '2026-09-16T00:00:00.000Z' })
  @Type(() => Date)
  @IsDate()
  migrationDate: Date;

  @ApiProperty({ example: '2026-12-16T00:00:00.000Z' })
  @Type(() => Date)
  @IsDate()
  termEndDate: Date;

  @ApiPropertyOptional({ example: 14, default: 14 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @IsOptional()
  expiresInDays?: number;
}