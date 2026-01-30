import { IsNotEmpty, IsUUID } from 'class-validator';

export class ConfirmPaymentDto {
  @IsUUID()
  @IsNotEmpty()
  paymentId: string;
}
