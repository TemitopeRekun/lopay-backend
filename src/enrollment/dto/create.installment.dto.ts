import { IsUUID, IsNumber, Min, IsNotEmpty } from 'class-validator';

export class CreateInstallmentDto {
  @IsUUID()
  @IsNotEmpty()
  enrollmentId: string;

  @IsNumber()
  @Min(1)
  amountPaid: number;
}