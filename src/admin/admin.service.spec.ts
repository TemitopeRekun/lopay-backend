import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DocumentsService } from '../documents/documents.service';
import { AuditService } from '../audit/audit.service';
import { PaystackService } from '../paystack/paystack.service';
import { LedgerService } from '../ledger/ledger.service';
import { SchoolOnboardingService } from '../school-onboarding/school-onboarding.service';
import { CacheService } from '../cache/cache.service';

describe('AdminService', () => {
  let service: AdminService;
  const paystack = {
    listBanks: jest.fn().mockResolvedValue([{ name: 'GTB', code: '058' }]),
    resolveAccount: jest.fn().mockResolvedValue({ accountName: 'Jane Doe' }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: DocumentsService, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: PaystackService, useValue: paystack },
        { provide: LedgerService, useValue: {} },
        { provide: SchoolOnboardingService, useValue: {} },
        {
          // Passthrough cache: always run the loader (no caching in unit tests).
          provide: CacheService,
          useValue: {
            getOrSet: (_k: string, _ttl: number, loader: () => unknown) =>
              loader(),
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get<AdminService>(AdminService);
  });

  it('passes through to Paystack for the bank list', async () => {
    await expect(service.listBanks()).resolves.toEqual([
      { name: 'GTB', code: '058' },
    ]);
    expect(paystack.listBanks).toHaveBeenCalledTimes(1);
  });

  it('resolves an account against Paystack', async () => {
    await expect(service.resolveAccount('0001', '058')).resolves.toEqual({
      accountName: 'Jane Doe',
    });
    expect(paystack.resolveAccount).toHaveBeenCalledWith('0001', '058');
  });

  it('rejects an account resolution missing the account number or bank code', async () => {
    await expect(service.resolveAccount('', '058')).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.resolveAccount('0001', '')).rejects.toThrow(
      BadRequestException,
    );
    expect(paystack.resolveAccount).not.toHaveBeenCalled();
  });
});
