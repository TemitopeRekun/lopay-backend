import { InstallmentFrequency } from '../../../generated/client/client';
import { IsString, IsNotEmpty, IsNumber, IsEnum, IsDate, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateEnrollmentDto {
  @IsString()
  @IsNotEmpty()
  childId: string;

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
}
