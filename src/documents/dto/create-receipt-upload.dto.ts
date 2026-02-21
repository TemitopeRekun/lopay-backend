import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateReceiptUploadDto {
  @ApiProperty({ example: 'receipt.jpg', description: 'Original file name' })
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @ApiPropertyOptional({
    example: 'image/jpeg',
    description: 'MIME type of the file',
  })
  @IsString()
  @IsOptional()
  contentType?: string;
}
