import { Test, TestingModule } from '@nestjs/testing';
import { TransactionsController } from './transactions.controller';
import { PaymentService } from './payment.service';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/decorators/user.decorator';

describe('TransactionsController', () => {
  let controller: TransactionsController;
  const service = { getHistory: jest.fn().mockResolvedValue({ data: [] }) };

  const parent: AuthUser = {
    userId: 'u1',
    role: UserRole.PARENT,
    schoolId: null,
  };
  const owner: AuthUser = {
    userId: 'o1',
    role: UserRole.SCHOOL_OWNER,
    schoolId: 's1',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [{ provide: PaymentService, useValue: service }],
    }).compile();
    controller = module.get<TransactionsController>(TransactionsController);
  });

  it('defaults every optional query param when none are supplied', async () => {
    await controller.getTransactions(parent);
    expect(service.getHistory).toHaveBeenCalledWith(
      'u1',
      UserRole.PARENT,
      undefined, // schoolId ?? undefined
      false, // includeReceiptSignedUrls !== 'true'
      'ALL', // receiptType default
      undefined, // page
      undefined, // limit
    );
  });

  it('parses the signed-url flag, receipt type, page and limit', async () => {
    await controller.getTransactions(owner, 'true', 'INSTALLMENT', '2', '50');
    expect(service.getHistory).toHaveBeenCalledWith(
      'o1',
      UserRole.SCHOOL_OWNER,
      's1', // schoolId passed through
      true, // 'true' → include
      'INSTALLMENT',
      2,
      50,
    );
  });

  it('treats any non-"true" flag value as false', async () => {
    await controller.getTransactions(parent, 'yes');
    expect(service.getHistory.mock.calls[0][3]).toBe(false);
  });
});
