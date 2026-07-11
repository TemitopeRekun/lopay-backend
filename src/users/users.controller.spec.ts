import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let controller: UsersController;
  const service = {
    findOne: jest.fn().mockResolvedValue({ id: 'u1' }),
    updateProfile: jest.fn().mockResolvedValue({ id: 'u1', name: 'Ada' }),
    findAll: jest.fn().mockResolvedValue([{ id: 'u1' }]),
    update: jest.fn().mockResolvedValue({ id: 'u2' }),
    remove: jest.fn().mockResolvedValue({ id: 'u3' }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: service }],
    }).compile();
    controller = module.get<UsersController>(UsersController);
  });

  it('getMe resolves the caller by their own id', async () => {
    await controller.getMe('u1');
    expect(service.findOne).toHaveBeenCalledWith('u1');
  });

  it('updateMe scopes the profile update to the caller', async () => {
    const dto = { name: 'Ada' } as never;
    await controller.updateMe('u1', dto);
    expect(service.updateProfile).toHaveBeenCalledWith('u1', dto);
  });

  it('findAll lists every user', async () => {
    await controller.findAll();
    expect(service.findAll).toHaveBeenCalledTimes(1);
  });

  it('findOne looks up an arbitrary user by id (admin path)', async () => {
    await controller.findOne('u9');
    expect(service.findOne).toHaveBeenCalledWith('u9');
  });

  it('update passes the id and dto through', async () => {
    const dto = { role: 'PARENT' } as never;
    await controller.update('u2', dto);
    expect(service.update).toHaveBeenCalledWith('u2', dto);
  });

  it('remove deletes by id', async () => {
    await controller.remove('u3');
    expect(service.remove).toHaveBeenCalledWith('u3');
  });
});
