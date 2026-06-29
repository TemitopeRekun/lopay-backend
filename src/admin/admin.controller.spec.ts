import { Test, TestingModule } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/decorators/user.decorator';

describe('AdminController', () => {
  let controller: AdminController;
  const service = {
    onboardSchool: jest.fn().mockResolvedValue({ message: 'ok' }),
    listBanks: jest.fn().mockResolvedValue([{ name: 'GTB', code: '058' }]),
    resolveAccount: jest.fn().mockResolvedValue({ accountName: 'Jane Doe' }),
    settleFirstPayment: jest.fn().mockResolvedValue({ settled: true }),
    getOverview: jest.fn().mockResolvedValue({ totalRevenue: 0 }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: AdminService, useValue: service }],
    }).compile();
    controller = module.get<AdminController>(AdminController);
  });

  it('delegates onboardSchool to the service with the DTO', async () => {
    const dto = { ownerEmail: 'a@b.com' } as never;
    await controller.onboardSchool(dto);
    expect(service.onboardSchool).toHaveBeenCalledWith(dto);
  });

  it('delegates resolveAccount with accountNumber + bankCode', async () => {
    await controller.resolveAccount({ accountNumber: '0001', bankCode: '058' });
    expect(service.resolveAccount).toHaveBeenCalledWith('0001', '058');
  });

  it('passes only the actor identity (userId/role) to settleFirstPayment', async () => {
    const user: AuthUser = {
      userId: 'admin-1',
      role: UserRole.SUPER_ADMIN,
      schoolId: null,
    };
    await controller.settleFirstPayment('pay-1', user);
    expect(service.settleFirstPayment).toHaveBeenCalledWith('pay-1', {
      userId: 'admin-1',
      role: UserRole.SUPER_ADMIN,
    });
  });

  it('delegates getOverview to the service', async () => {
    await controller.getOverview();
    expect(service.getOverview).toHaveBeenCalledTimes(1);
  });
});
