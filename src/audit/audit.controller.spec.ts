import { Test, TestingModule } from '@nestjs/testing';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

describe('AuditController', () => {
  let controller: AuditController;
  const service = { list: jest.fn().mockResolvedValue([{ id: 'a1' }]) };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [{ provide: AuditService, useValue: service }],
    }).compile();
    controller = module.get<AuditController>(AuditController);
  });

  it('passes filters through and parses take/skip as integers', async () => {
    await controller.list('Payment', 'p1', 's1', 'actor1', '25', '50');
    expect(service.list).toHaveBeenCalledWith({
      entityType: 'Payment',
      entityId: 'p1',
      schoolId: 's1',
      actorUserId: 'actor1',
      take: 25,
      skip: 50,
    });
  });

  it('leaves take/skip undefined when not supplied', async () => {
    await controller.list();
    expect(service.list).toHaveBeenCalledWith({
      entityType: undefined,
      entityId: undefined,
      schoolId: undefined,
      actorUserId: undefined,
      take: undefined,
      skip: undefined,
    });
  });
});
