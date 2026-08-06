import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateReceiptUploadDto {
  @ApiProperty({ example: 'receipt.jpg', description: 'Original file name' })
  @IsString()
  @IsNotEmpty()
  fileName: string;

  /**
   * Required, not optional. The service only checks the MIME allow-list when a
   * contentType is supplied, so an omitted one skipped the check entirely and
   * left the bucket's own configuration as the sole gate on what could be
   * written. Making it mandatory means the allow-list always runs.
   */
  @ApiProperty({
    example: 'image/jpeg',
    description:
      'MIME type of the file. Must be one of: image/jpeg, image/png, image/webp, application/pdf.',
  })
  @IsString()
  @IsNotEmpty()
  contentType: string;
}
