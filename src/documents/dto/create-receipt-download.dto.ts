import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class CreateReceiptDownloadDto {
  @ApiProperty({ example: 'payment-uuid' })
  @IsUUID()
  @IsNotEmpty()
  paymentId: string;
}
