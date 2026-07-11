import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { SchoolPaymentsController } from './schools.controller';
import { SchoolPaymentsService } from './schools.service';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/decorators/user.decorator';
import type { CreateClassFeeDto } from './dto/create-class-fee.dto';
import type { UpdateSchoolDto } from './dto/update.school.dto';
import type { ConfirmPaymentDto } from './dto/confim.payment.dto';
import type { MarkDefaultedDto } from './dto/mark-defaulted.dto';
import type { ReversePaymentDto } from './dto/reverse.payment.dto';

describe('SchoolPaymentsController', () => {
  let controller: SchoolPaymentsController;

  const service = {
    createClassFee: jest.fn().mockResolvedValue({ id: 'fee-1' }),
    getClassFees: jest.fn().mockResolvedValue([{ id: 'fee-1' }]),
    getSchoolBankDetails: jest.fn().mockResolvedValue({ bankName: 'GTB' }),
    updateSchoolBankDetails: jest.fn().mockResolvedValue({ updated: true }),
    getHistory: jest.fn().mockResolvedValue([{ id: 'p1' }]),
    getDashboardStats: jest.fn().mockResolvedValue({ total: 1 }),
    getStudents: jest.fn().mockResolvedValue({ data: [] }),
    getPendingPayments: jest.fn().mockResolvedValue([{ id: 'p2' }]),
    confirmPayment: jest.fn().mockResolvedValue({ confirmed: true }),
    rejectPayment: jest.fn().mockResolvedValue({ rejected: true }),
    markEnrollmentAsDefaulted: jest.fn().mockResolvedValue({ defaulted: true }),
    reversePayment: jest.fn().mockResolvedValue({ reversed: true }),
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
  const parent: AuthUser = {
    userId: 'parent-1',
    role: UserRole.PARENT,
    schoolId: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SchoolPaymentsController],
      providers: [{ provide: SchoolPaymentsService, useValue: service }],
    }).compile();
    controller = module.get<SchoolPaymentsController>(SchoolPaymentsController);
  });

  describe('createClassFee', () => {
    const dto = { className: 'Grade 1', feeAmount: 50000 } as CreateClassFeeDto;

    it('delegates with the owner schoolId, class name and fee amount', async () => {
      await controller.createClassFee(dto, owner);
      expect(service.createClassFee).toHaveBeenCalledWith(
        'school-1',
        'Grade 1',
        50000,
      );
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.createClassFee(dto, ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.createClassFee).not.toHaveBeenCalled();
    });
  });

  describe('getClassFees', () => {
    it('returns the owner school fees for a school owner', async () => {
      await controller.getClassFees(owner);
      expect(service.getClassFees).toHaveBeenCalledWith('school-1');
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.getClassFees(ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.getClassFees).not.toHaveBeenCalled();
    });

    it('directs non-owners to the public endpoint', async () => {
      await expect(controller.getClassFees(parent)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(service.getClassFees).not.toHaveBeenCalled();
    });
  });

  it('getClassFeesForSchool delegates the path schoolId', async () => {
    await controller.getClassFeesForSchool('school-9');
    expect(service.getClassFees).toHaveBeenCalledWith('school-9');
  });

  it('getSchoolBankDetails forwards the caller scope', async () => {
    await controller.getSchoolBankDetails('school-9', owner);
    expect(service.getSchoolBankDetails).toHaveBeenCalledWith('school-9', {
      userId: 'owner-1',
      role: UserRole.SCHOOL_OWNER,
      schoolId: 'school-1',
    });
  });

  describe('updateSchoolBankDetails', () => {
    const dto = { bankName: 'GTB' } as UpdateSchoolDto;

    it('delegates with the owner schoolId and dto', async () => {
      await controller.updateSchoolBankDetails(dto, owner);
      expect(service.updateSchoolBankDetails).toHaveBeenCalledWith(
        'school-1',
        dto,
      );
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.updateSchoolBankDetails(dto, ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.updateSchoolBankDetails).not.toHaveBeenCalled();
    });
  });

  describe('getHistory', () => {
    it('applies defaults when no query params are given', async () => {
      await controller.getHistory(owner);
      expect(service.getHistory).toHaveBeenCalledWith(
        'school-1',
        false,
        'ALL',
        100,
      );
    });

    it('honours query params and clamps take to 200', async () => {
      await controller.getHistory(owner, 'true', 'INSTALLMENT', '500');
      expect(service.getHistory).toHaveBeenCalledWith(
        'school-1',
        true,
        'INSTALLMENT',
        200,
      );
    });

    it('passes a take below the cap unchanged', async () => {
      await controller.getHistory(owner, 'false', 'FIRST_PAYMENT', '50');
      expect(service.getHistory).toHaveBeenCalledWith(
        'school-1',
        false,
        'FIRST_PAYMENT',
        50,
      );
    });

    it('throws when the owner has no school', async () => {
      await expect(controller.getHistory(ownerNoSchool)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(service.getHistory).not.toHaveBeenCalled();
    });
  });

  describe('getHistoryAll', () => {
    it('applies defaults when no query params are given', async () => {
      await controller.getHistoryAll(owner);
      expect(service.getHistory).toHaveBeenCalledWith(
        'school-1',
        false,
        'ALL',
        100,
      );
    });

    it('honours query params and clamps take to 200', async () => {
      await controller.getHistoryAll(owner, 'true', 'INSTALLMENT', '999');
      expect(service.getHistory).toHaveBeenCalledWith(
        'school-1',
        true,
        'INSTALLMENT',
        200,
      );
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.getHistoryAll(ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.getHistory).not.toHaveBeenCalled();
    });
  });

  describe('getDashboardStats', () => {
    it('delegates with the owner schoolId', async () => {
      await controller.getDashboardStats(owner);
      expect(service.getDashboardStats).toHaveBeenCalledWith('school-1');
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.getDashboardStats(ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.getDashboardStats).not.toHaveBeenCalled();
    });
  });

  describe('getStudents', () => {
    it('applies pagination defaults', async () => {
      await controller.getStudents(owner);
      expect(service.getStudents).toHaveBeenCalledWith(
        'school-1',
        undefined,
        undefined,
        1,
        50,
      );
    });

    it('parses filters and clamps limit to 200', async () => {
      await controller.getStudents(owner, 'Grade 1', 'timmy', '2', '500');
      expect(service.getStudents).toHaveBeenCalledWith(
        'school-1',
        'Grade 1',
        'timmy',
        2,
        200,
      );
    });

    it('passes a limit below the cap unchanged', async () => {
      await controller.getStudents(owner, undefined, undefined, '3', '10');
      expect(service.getStudents).toHaveBeenCalledWith(
        'school-1',
        undefined,
        undefined,
        3,
        10,
      );
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.getStudents(ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.getStudents).not.toHaveBeenCalled();
    });
  });

  describe('getPendingPayments', () => {
    it('applies defaults', async () => {
      await controller.getPendingPayments(owner);
      expect(service.getPendingPayments).toHaveBeenCalledWith(
        'school-1',
        false,
        'ALL',
      );
    });

    it('honours query params', async () => {
      await controller.getPendingPayments(owner, 'true', 'INSTALLMENT');
      expect(service.getPendingPayments).toHaveBeenCalledWith(
        'school-1',
        true,
        'INSTALLMENT',
      );
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.getPendingPayments(ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.getPendingPayments).not.toHaveBeenCalled();
    });
  });

  describe('confirmPayment', () => {
    const dto = { paymentId: 'pay-1' } as ConfirmPaymentDto;

    it('delegates with payment id, schoolId and actor', async () => {
      await controller.confirmPayment(dto, owner);
      expect(service.confirmPayment).toHaveBeenCalledWith('pay-1', 'school-1', {
        userId: 'owner-1',
        role: UserRole.SCHOOL_OWNER,
      });
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.confirmPayment(dto, ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.confirmPayment).not.toHaveBeenCalled();
    });
  });

  describe('rejectPayment', () => {
    const dto = { paymentId: 'pay-1' } as ConfirmPaymentDto;

    it('delegates with payment id, schoolId and actor', async () => {
      await controller.rejectPayment(dto, owner);
      expect(service.rejectPayment).toHaveBeenCalledWith('pay-1', 'school-1', {
        userId: 'owner-1',
        role: UserRole.SCHOOL_OWNER,
      });
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.rejectPayment(dto, ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.rejectPayment).not.toHaveBeenCalled();
    });
  });

  describe('markAsDefaulted', () => {
    const dto = { enrollmentId: 'enr-1' } as MarkDefaultedDto;

    it('delegates with enrollment id, schoolId and actor', async () => {
      await controller.markAsDefaulted(dto, owner);
      expect(service.markEnrollmentAsDefaulted).toHaveBeenCalledWith(
        'enr-1',
        'school-1',
        { userId: 'owner-1', role: UserRole.SCHOOL_OWNER },
      );
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.markAsDefaulted(dto, ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.markEnrollmentAsDefaulted).not.toHaveBeenCalled();
    });
  });

  describe('reversePayment', () => {
    const dto = { paymentId: 'pay-1', reason: 'oops' } as ReversePaymentDto;

    it('delegates with payment id, schoolId, actor and reason', async () => {
      await controller.reversePayment(dto, owner);
      expect(service.reversePayment).toHaveBeenCalledWith(
        'pay-1',
        'school-1',
        { userId: 'owner-1', role: UserRole.SCHOOL_OWNER },
        'oops',
      );
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.reversePayment(dto, ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.reversePayment).not.toHaveBeenCalled();
    });
  });
});
