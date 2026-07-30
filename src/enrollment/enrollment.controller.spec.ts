import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { EnrollmentController } from './enrollment.controller';
import { EnrollmentService } from './enrollment.service';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/decorators/user.decorator';
import type { CreateEnrollmentDto } from './dto/create.enrollment.dto';
import type { CreateInstallmentDto } from './dto/create.installment.dto';
import type { ConfirmEnrollmentDto } from './dto/confirm.enrollment.dto';

describe('EnrollmentController', () => {
  let controller: EnrollmentController;

  const service = {
    getParentEnrollments: jest.fn().mockResolvedValue([{ id: 'e1' }]),
    getEnrollmentHistory: jest.fn().mockResolvedValue([{ id: 'p1' }]),
    initiateFirstPayment: jest.fn().mockResolvedValue({ accessCode: 'ac_1' }),
    submitInstallmentPayment: jest.fn().mockResolvedValue({ id: 'p2' }),
    confirmFirstPayment: jest.fn().mockResolvedValue({ confirmed: true }),
  };

  const parent: AuthUser = {
    userId: 'parent-1',
    role: UserRole.PARENT,
    schoolId: null,
  };
  const owner: AuthUser = {
    userId: 'owner-1',
    role: UserRole.SCHOOL_OWNER,
    schoolId: 'school-1',
  };
  const ownerNoSchool: AuthUser = {
    userId: 'owner-2',
    role: UserRole.SCHOOL_OWNER,
    schoolId: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EnrollmentController],
      providers: [{ provide: EnrollmentService, useValue: service }],
    }).compile();
    controller = module.get<EnrollmentController>(EnrollmentController);
  });

  it('getMyChildren scopes to the authenticated parent', async () => {
    await controller.getMyChildren(parent);
    expect(service.getParentEnrollments).toHaveBeenCalledWith('parent-1');
  });

  it('getEnrollmentHistory passes the enrollment id and caller userId', async () => {
    await controller.getEnrollmentHistory('e1', parent);
    expect(service.getEnrollmentHistory).toHaveBeenCalledWith('e1', 'parent-1');
  });

  it('initiateFirstPayment forwards the dto and caller userId', () => {
    const dto = {
      schoolId: 'school-1',
      className: 'Grade 1',
    } as CreateEnrollmentDto;
    controller.initiateFirstPayment(dto, parent);
    expect(service.initiateFirstPayment).toHaveBeenCalledWith(dto, 'parent-1');
  });

  it('payInstallment forwards installment fields and caller scope', async () => {
    const dto = {
      enrollmentId: 'e1',
      amountPaid: 2000,
      receiptUrl: 'receipts/x.jpg',
      idempotencyKey: 'key-1',
    } as CreateInstallmentDto;

    await controller.payInstallment(dto, owner);

    expect(service.submitInstallmentPayment).toHaveBeenCalledWith(
      'e1',
      2000,
      { userId: 'owner-1', role: UserRole.SCHOOL_OWNER, schoolId: 'school-1' },
      'receipts/x.jpg',
      'key-1',
    );
  });

  describe('confirmFirstPayment', () => {
    const dto = { enrollmentId: 'e1' } as ConfirmEnrollmentDto;

    it('delegates with the enrollment id, session schoolId and actor', async () => {
      await controller.confirmFirstPayment(dto, owner);
      expect(service.confirmFirstPayment).toHaveBeenCalledWith(
        'e1',
        'school-1',
        { userId: 'owner-1', role: UserRole.SCHOOL_OWNER },
      );
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.confirmFirstPayment(dto, ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.confirmFirstPayment).not.toHaveBeenCalled();
    });
  });
});
