import { Body, Controller, Post } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { CreateReceiptUploadDto } from './dto/create-receipt-upload.dto';
import { CreateReceiptDownloadDto } from './dto/create-receipt-download.dto';
import { CurrentUser } from '../common/decorators/user.decorator';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('receipts/upload-url')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER)
  async createReceiptUploadUrl(
    @Body() dto: CreateReceiptUploadDto,
    @CurrentUser() user: any,
  ) {
    return this.documentsService.createReceiptUploadUrl(
      user.userId,
      dto.fileName,
      dto.contentType,
    );
  }

  @Post('receipts/download-url')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER, UserRole.SUPER_ADMIN)
  async createReceiptDownloadUrl(
    @Body() dto: CreateReceiptDownloadDto,
    @CurrentUser() user: any,
  ) {
    return this.documentsService.createReceiptDownloadUrl(
      dto.paymentId,
      user,
    );
  }
}
