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
    setClassFees: jest.fn().mockResolvedValue([{ id: 'fee-1' }]),
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

  describe('setClassFees (bulk publish)', () => {
    const dto = {
      fees: [
        { className: 'JSS1', feeAmount: 120000 },
        { className: 'JSS2', feeAmount: 150000 },
      ],
    };

    it('publishes the whole schedule against the session school', async () => {
      await controller.setClassFees(dto, owner);
      expect(service.setClassFees).toHaveBeenCalledWith('school-1', dto.fees);
    });

    it('takes the school from the session, never from the payload', async () => {
      // A school owns its own fees: an injected schoolId must be ignored, so one
      // school can never publish a fee schedule onto another.
      await controller.setClassFees(
        { ...dto, schoolId: 'someone-elses-school' } as never,
        owner,
      );
      expect(service.setClassFees).toHaveBeenCalledWith('school-1', dto.fees);
    });

    it('throws when the owner has no school', async () => {
      await expect(
        controller.setClassFees(dto, ownerNoSchool),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.setClassFees).not.toHaveBeenCalled();
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
        undefined,
        undefined,
        0,
      );
    });

    it('honours query params up to the export ceiling', async () => {
      await controller.getHistory(owner, 'true', 'INSTALLMENT', '500');
      expect(service.getHistory).toHaveBeenCalledWith(
        'school-1',
        true,
        'INSTALLMENT',
        500,
        undefined,
        undefined,
        0,
      );
    });

    it('passes a take below the cap unchanged', async () => {
      await controller.getHistory(owner, 'false', 'FIRST_PAYMENT', '50');
      expect(service.getHistory).toHaveBeenCalledWith(
        'school-1',
        false,
        'FIRST_PAYMENT',
        50,
        undefined,
        undefined,
        0,
      );
    });

    it('clamps take to the export ceiling', async () => {
      await controller.getHistory(owner, 'false', 'ALL', '99999');
      expect(service.getHistory).toHaveBeenCalledWith(
        'school-1',
        false,
        'ALL',
        1000,
        undefined,
        undefined,
        0,
      );
    });

    it('ignores a non-numeric or non-positive take', async () => {
      await controller.getHistory(owner, 'false', 'ALL', 'abc');
      expect(service.getHistory).toHaveBeenLastCalledWith(
        'school-1',
        false,
        'ALL',
        100,
        undefined,
        undefined,
        0,
      );
      await controller.getHistory(owner, 'false', 'ALL', '0');
      expect(service.getHistory).toHaveBeenLastCalledWith(
        'school-1',
        false,
        'ALL',
        100,
        undefined,
        undefined,
        0,
      );
    });

    /* Backs the monthly collection-ledger export. */
    it('parses a from/to window', async () => {
      await controller.getHistory(
        owner,
        'false',
        'ALL',
        '1000',
        '2026-02-01T00:00:00.000Z',
        '2026-02-28T23:59:59.999Z',
      );
      expect(service.getHistory).toHaveBeenCalledWith(
        'school-1',
        false,
        'ALL',
        1000,
        {
          from: new Date('2026-02-01T00:00:00.000Z'),
          to: new Date('2026-02-28T23:59:59.999Z'),
        },
        undefined,
        0,
      );
    });

    it('accepts a one-sided window', async () => {
      await controller.getHistory(
        owner,
        'false',
        'ALL',
        undefined,
        '2026-02-01T00:00:00.000Z',
      );
      expect(service.getHistory).toHaveBeenCalledWith(
        'school-1',
        false,
        'ALL',
        100,
        { from: new Date('2026-02-01T00:00:00.000Z'), to: undefined },
        undefined,
        0,
      );
    });

    it('ignores an unparseable date instead of filtering on NaN', async () => {
      await controller.getHistory(
        owner,
        'false',
        'ALL',
        undefined,
        'not-a-date',
      );
      expect(service.getHistory).toHaveBeenCalledWith(
        'school-1',
        false,
        'ALL',
        100,
        undefined,
        undefined,
        0,
      );
    });

    /*
     * The history screen's status tabs narrow the SQL query. Filtering a fetched
     * page client-side would search only that page, so a long history would
     * under-report every tab while looking complete.
     */
    it('forwards a recognised status', async () => {
      await controller.getHistory(
        owner,
        'false',
        'ALL',
        undefined,
        undefined,
        undefined,
        'PENDING',
      );
      expect(service.getHistory).toHaveBeenLastCalledWith(
        'school-1',
        false,
        'ALL',
        100,
        undefined,
        'PENDING',
        0,
      );
    });

    /*
     * A typo must not narrow the ledger: an empty page renders as "no
     * transactions", which is indistinguishable from an empty history.
     */
    it('ignores an unrecognised status', async () => {
      await controller.getHistory(
        owner,
        'false',
        'ALL',
        undefined,
        undefined,
        undefined,
        'NOPE',
      );
      expect(service.getHistory.mock.calls.at(-1)?.[5]).toBeUndefined();
    });

    it('converts ?page= into a row offset for the page size', async () => {
      await controller.getHistory(
        owner,
        'false',
        'ALL',
        '50',
        undefined,
        undefined,
        undefined,
        '3',
      );
      // page 3 at 50/page starts at row 100.
      expect(service.getHistory.mock.calls.at(-1)?.[6]).toBe(100);
    });

    it('treats a missing or sub-1 page as the first page', async () => {
      await controller.getHistory(owner);
      expect(service.getHistory.mock.calls.at(-1)?.[6]).toBe(0);
      await controller.getHistory(
        owner,
        'false',
        'ALL',
        undefined,
        undefined,
        undefined,
        undefined,
        '0',
      );
      expect(service.getHistory.mock.calls.at(-1)?.[6]).toBe(0);
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
        undefined,
      );
    });

    it('honours query params up to the export ceiling', async () => {
      await controller.getHistoryAll(owner, 'true', 'INSTALLMENT', '999');
      expect(service.getHistory).toHaveBeenCalledWith(
        'school-1',
        true,
        'INSTALLMENT',
        999,
        undefined,
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
        100,
        'INSTALLMENT',
      );
    });

    it('honours query params', async () => {
      await controller.getPendingPayments(owner, 'true', 'INSTALLMENT');
      expect(service.getPendingPayments).toHaveBeenCalledWith(
        'school-1',
        true,
        'INSTALLMENT',
        100,
        'INSTALLMENT',
      );
    });

    it('can widen the queue to first payments', async () => {
      await controller.getPendingPayments(owner, 'false', 'ALL', 'ALL');
      expect(service.getPendingPayments).toHaveBeenCalledWith(
        'school-1',
        false,
        'ALL',
        100,
        'ALL',
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
