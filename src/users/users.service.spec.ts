import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';

describe('UsersService.updateProfile', () => {
  const prisma = {
    user: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({ id: 'u1' }),
    },
  };
  const service = new UsersService(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  it('mirrors fullName onto Better Auth `name` and updates phone', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
    await service.updateProfile('u1', {
      fullName: 'New Name',
      phoneNumber: '+234',
    });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: { fullName: 'New Name', name: 'New Name', phoneNumber: '+234' },
      }),
    );
  });

  it('never writes role or email (self-service cannot escalate)', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
    await service.updateProfile('u1', { fullName: 'X' });
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('role');
    expect(data).not.toHaveProperty('email');
  });

  it('404s for an unknown user', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.updateProfile('missing', { fullName: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
