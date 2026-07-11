import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { DocumentsService } from './documents.service';
import { CreateReceiptUploadDto } from './dto/create-receipt-upload.dto';
import { CreateReceiptDownloadDto } from './dto/create-receipt-download.dto';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';

@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('receipts/upload-url')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER)
  @ApiOperation({ summary: 'Create a signed URL for uploading a receipt' })
  async createReceiptUploadUrl(
    @Body() dto: CreateReceiptUploadDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentsService.createReceiptUploadUrl(
      user.userId,
      dto.fileName,
      dto.contentType,
    );
  }

  @Post('receipts/download-url')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a signed URL for downloading a receipt' })
  async createReceiptDownloadUrl(
    @Body() dto: CreateReceiptDownloadDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentsService.createReceiptDownloadUrl(dto.paymentId, user);
  }
}
