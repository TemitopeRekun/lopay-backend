import { Test, TestingModule } from '@nestjs/testing';
import { DeviceTokensController } from './device-tokens.controller';
import { DeviceTokensService } from './device-tokens.service';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/decorators/user.decorator';

describe('DeviceTokensController', () => {
  let controller: DeviceTokensController;
  const service = {
    register: jest.fn().mockResolvedValue({ id: 'dt1' }),
    unregister: jest.fn().mockResolvedValue({ count: 1 }),
  };

  const user: AuthUser = {
    userId: 'u1',
    role: UserRole.PARENT,
    schoolId: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeviceTokensController],
      providers: [{ provide: DeviceTokensService, useValue: service }],
    }).compile();
    controller = module.get<DeviceTokensController>(DeviceTokensController);
  });

  it('registers a token against the authenticated user', async () => {
    const dto = { token: 'fcm-abc', platform: 'android' } as never;
    await controller.register(dto, user);
    expect(service.register).toHaveBeenCalledWith('u1', dto);
  });

  it('unregisters by token, scoped to the authenticated user', async () => {
    const dto = { token: 'fcm-abc' } as never;
    await controller.unregister(dto, user);
    expect(service.unregister).toHaveBeenCalledWith('u1', 'fcm-abc');
  });
});
