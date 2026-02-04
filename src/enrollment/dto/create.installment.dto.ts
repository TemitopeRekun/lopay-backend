import { IsUUID, IsNumber, Min, IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class CreateInstallmentDto {
  @IsUUID()
  @IsNotEmpty()
  enrollmentId: string;

  @IsNumber()
  @Min(1)
  amountPaid: number;

  @IsString()
  @IsOptional()
  receiptUrl?: string;
}