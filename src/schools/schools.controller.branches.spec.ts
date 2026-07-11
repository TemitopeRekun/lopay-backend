import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { SchoolPaymentsController } from './schools.controller';
import { SchoolPaymentsService } from './schools.service';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/decorators/user.decorator';

/**
 * Branch coverage for SchoolPaymentsController: the `!user.schoolId` Forbidden
 * guard on every owner-scoped route, plus the query-param default ternaries on
 * the history / students / pending routes. The service is fully stubbed.
 */
describe('SchoolPaymentsController — guards & query defaults', () => {
  let controller: SchoolPaymentsController;
  const service = {
    createClassFee: jest.fn().mockResolvedValue({}),
    getClassFees: jest.fn().mockResolvedValue([]),
    getSchoolBankDetails: jest.fn().mockResolvedValue({}),
    updateSchoolBankDetails: jest.fn().mockResolvedValue({}),
    getHistory: jest.fn().mockResolvedValue({ data: [] }),
    getDashboardStats: jest.fn().mockResolvedValue({}),
    getStudents: jest.fn().mockResolvedValue({ data: [] }),
    getPendingPayments: jest.fn().mockResolvedValue([]),
    confirmPayment: jest.fn().mockResolvedValue({}),
    rejectPayment: jest.fn().mockResolvedValue({}),
    markEnrollmentAsDefaulted: jest.fn().mockResolvedValue({}),
    reversePayment: jest.fn().mockResolvedValue({}),
  };

  const owner: AuthUser = {
    userId: 'o1',
    role: UserRole.SCHOOL_OWNER,
    schoolId: 's1',
  };
  const orphan: AuthUser = {
    userId: 'o2',
    role: UserRole.SCHOOL_OWNER,
    schoolId: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SchoolPaymentsController],
      providers: [{ provide: SchoolPaymentsService, useValue: service }],
    }).compile();
    controller = module.get(SchoolPaymentsController);
  });

  describe('rejects an owner not associated with a school', () => {
    it.each([
      ['createClassFee', () => controller.createClassFee({} as never, orphan)],
      [
        'updateSchoolBankDetails',
        () => controller.updateSchoolBankDetails({} as never, orphan),
      ],
      ['getHistory', () => controller.getHistory(orphan)],
      ['getHistoryAll', () => controller.getHistoryAll(orphan)],
      ['getDashboardStats', () => controller.getDashboardStats(orphan)],
      ['getStudents', () => controller.getStudents(orphan)],
      ['getPendingPayments', () => controller.getPendingPayments(orphan)],
      [
        'confirmPayment',
        () => controller.confirmPayment({ paymentId: 'p' } as never, orphan),
      ],
      [
        'rejectPayment',
        () => controller.rejectPayment({ paymentId: 'p' } as never, orphan),
      ],
      [
        'markAsDefaulted',
        () =>
          controller.markAsDefaulted({ enrollmentId: 'e' } as never, orphan),
      ],
      [
        'reversePayment',
        () => controller.reversePayment({ paymentId: 'p' } as never, orphan),
      ],
    ])('%s throws Forbidden', async (_name, call) => {
      await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('getClassFees role branches', () => {
    it('returns the owner’s fees when a school is associated', async () => {
      await controller.getClassFees(owner);
      expect(service.getClassFees).toHaveBeenCalledWith('s1');
    });

    it('throws Forbidden for an owner without a school', async () => {
      await expect(controller.getClassFees(orphan)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('directs parents to the public endpoint', async () => {
      const parent: AuthUser = {
        userId: 'p1',
        role: UserRole.PARENT,
        schoolId: null,
      };
      await expect(controller.getClassFees(parent)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('query-param defaults vs supplied values', () => {
    it('getHistory defaults include=false, receiptType=ALL, take=100', async () => {
      await controller.getHistory(owner);
      expect(service.getHistory).toHaveBeenCalledWith('s1', false, 'ALL', 100);
    });

    it('getHistory honours the flag, type and caps take at 200', async () => {
      await controller.getHistory(owner, 'true', 'INSTALLMENT', '9999');
      expect(service.getHistory).toHaveBeenCalledWith(
        's1',
        true,
        'INSTALLMENT',
        200,
      );
    });

    it('getHistoryAll applies the same defaults', async () => {
      await controller.getHistoryAll(owner, 'true', 'FIRST_PAYMENT', '10');
      expect(service.getHistory).toHaveBeenCalledWith(
        's1',
        true,
        'FIRST_PAYMENT',
        10,
      );
    });

    it('getStudents defaults page=1, limit=50', async () => {
      await controller.getStudents(owner);
      expect(service.getStudents).toHaveBeenCalledWith(
        's1',
        undefined,
        undefined,
        1,
        50,
      );
    });

    it('getStudents parses filters and caps limit at 200', async () => {
      await controller.getStudents(owner, 'JSS1', 'ada', '3', '9999');
      expect(service.getStudents).toHaveBeenCalledWith(
        's1',
        'JSS1',
        'ada',
        3,
        200,
      );
    });

    it('getPendingPayments defaults include=false, receiptType=ALL', async () => {
      await controller.getPendingPayments(owner);
      expect(service.getPendingPayments).toHaveBeenCalledWith(
        's1',
        false,
        'ALL',
      );
    });

    it('getPendingPayments honours the flag and type', async () => {
      await controller.getPendingPayments(owner, 'true', 'INSTALLMENT');
      expect(service.getPendingPayments).toHaveBeenCalledWith(
        's1',
        true,
        'INSTALLMENT',
      );
    });
  });

  describe('pass-through routes', () => {
    it('getClassFeesForSchool forwards the path param', async () => {
      await controller.getClassFeesForSchool('s9');
      expect(service.getClassFees).toHaveBeenCalledWith('s9');
    });

    it('getSchoolBankDetails forwards the caller identity for server-side scoping', async () => {
      await controller.getSchoolBankDetails('s9', owner);
      expect(service.getSchoolBankDetails).toHaveBeenCalledWith('s9', {
        userId: 'o1',
        role: UserRole.SCHOOL_OWNER,
        schoolId: 's1',
      });
    });
  });
});
