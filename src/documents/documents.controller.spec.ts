import { Test, TestingModule } from '@nestjs/testing';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/decorators/user.decorator';

describe('DocumentsController', () => {
  let controller: DocumentsController;
  const service = {
    createReceiptUploadUrl: jest
      .fn()
      .mockResolvedValue({ uploadUrl: 'https://up', objectKey: 'k' }),
    createReceiptDownloadUrl: jest
      .fn()
      .mockResolvedValue({ downloadUrl: 'https://down' }),
  };

  const user: AuthUser = {
    userId: 'u1',
    role: UserRole.PARENT,
    schoolId: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [{ provide: DocumentsService, useValue: service }],
    }).compile();
    controller = module.get<DocumentsController>(DocumentsController);
  });

  it('creates an upload URL scoped to the caller with file metadata', async () => {
    const dto = { fileName: 'receipt.png', contentType: 'image/png' } as never;
    await controller.createReceiptUploadUrl(dto, user);
    expect(service.createReceiptUploadUrl).toHaveBeenCalledWith(
      'u1',
      'receipt.png',
      'image/png',
    );
  });

  it('creates a download URL, passing the payment id and the caller for authz', async () => {
    const dto = { paymentId: 'pay1' } as never;
    await controller.createReceiptDownloadUrl(dto, user);
    expect(service.createReceiptDownloadUrl).toHaveBeenCalledWith('pay1', user);
  });
});
