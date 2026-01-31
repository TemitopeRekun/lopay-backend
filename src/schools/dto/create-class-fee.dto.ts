import { IsString, IsNotEmpty, IsNumber, Min } from 'class-validator';

export class CreateClassFeeDto {
  @IsString()
  @IsNotEmpty()
  className: string;

  @IsNumber()
  @Min(0)
  feeAmount: number;
}