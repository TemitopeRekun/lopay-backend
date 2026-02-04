import { InstallmentFrequency } from '../../generated/prisma/client';
import { IsString, IsNotEmpty, IsNumber, IsEnum, IsDate, Min, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateEnrollmentDto {
  @IsString()
  @IsOptional()
  childId?: string;

  @IsString()
  @IsOptional()
  childName?: string;

  @IsString()
  @IsNotEmpty()
  schoolId: string;

  @IsString()
  @IsNotEmpty()
  className: string;

  @IsEnum(InstallmentFrequency)
  installmentFrequency: InstallmentFrequency;

  @IsNumber()
  @Min(0)
  firstPaymentPaid: number;

  @Type(() => Date)
  @IsDate()
  termStartDate: Date;

  @Type(() => Date)
  @IsDate()
  termEndDate: Date;

  @IsString()
  @IsOptional()
  receiptUrl?: string;
}
