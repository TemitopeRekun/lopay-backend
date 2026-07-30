import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentsService } from '../documents/documents.service';
import { UserRole } from '../generated/prisma/client';

/**
 * Branch coverage for the two methods the base spec doesn't exercise:
 * `getHistory` (role scoping, pagination clamps, receipt-signing paths) and the
 * below-platform-fee edge of `updateRemainingBalance`.
 */
describe('PaymentService.getHistory', () => {
  let service: PaymentService;
  const findMany = jest.fn();
  const createSignedUrlForPath = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: { payment: { findMany } } },
        { provide: DocumentsService, useValue: { createSignedUrlForPath } },
      ],
    }).compile();
    service = module.get<PaymentService>(PaymentService);
  });

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    amountPaid: 25_000,
    status: 'CONFIRMED',
    paymentType: 'INSTALLMENT',
    receiptUrl: null as string | null,
    paymentDate: new Date('2026-01-01T00:00:00Z'),
    enrollment: {
      className: 'JSS1',
      child: { fullName: 'Ada' },
      school: { name: 'Acme' },
    },
    ...over,
  });

  it('scopes a PARENT to their own payments and converts kobo→naira', async () => {
    findMany.mockResolvedValue([row()]);
    const res = await service.getHistory('u1', UserRole.PARENT);
    expect(findMany.mock.calls[0][0].where).toEqual({
      enrollment: { child: { parent: { userId: 'u1' } } },
    });
    expect(res[0].amount).toBe(250); // 25_000 kobo → ₦250
  });

  it('scopes a SCHOOL_OWNER to their school', async () => {
    findMany.mockResolvedValue([]);
    await service.getHistory('o1', UserRole.SCHOOL_OWNER, 's1');
    expect(findMany.mock.calls[0][0].where).toEqual({ schoolId: 's1' });
  });

  it('forbids a school owner without a schoolId', async () => {
    await expect(
      service.getHistory('o1', UserRole.SCHOOL_OWNER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('default-denies any other role (e.g. super admin) rather than leaking', async () => {
    await expect(
      service.getHistory('a1', UserRole.SUPER_ADMIN),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('caps limit at 200 and floors page at 1', async () => {
    findMany.mockResolvedValue([]);
    await service.getHistory(
      'u1',
      UserRole.PARENT,
      undefined,
      false,
      'ALL',
      0,
      9999,
    );
    const arg = findMany.mock.calls[0][0];
    expect(arg.take).toBe(200);
    expect(arg.skip).toBe(0);
  });

  it('computes skip from page × take', async () => {
    findMany.mockResolvedValue([]);
    await service.getHistory(
      'u1',
      UserRole.PARENT,
      undefined,
      false,
      'ALL',
      3,
      10,
    );
    const arg = findMany.mock.calls[0][0];
    expect(arg.take).toBe(10);
    expect(arg.skip).toBe(20);
  });

  it('omits receiptSignedUrl entirely when signed URLs are not requested', async () => {
    findMany.mockResolvedValue([row({ receiptUrl: 'r/1' })]);
    const res = await service.getHistory(
      'u1',
      UserRole.PARENT,
      undefined,
      false,
    );
    expect(res[0]).not.toHaveProperty('receiptSignedUrl');
    expect(createSignedUrlForPath).not.toHaveBeenCalled();
  });

  it('signs the receipt when requested and the type matches', async () => {
    createSignedUrlForPath.mockResolvedValue({ signedUrl: 'https://signed' });
    findMany.mockResolvedValue([
      row({ receiptUrl: 'r/1', paymentType: 'INSTALLMENT' }),
    ]);
    const res = await service.getHistory(
      'u1',
      UserRole.PARENT,
      undefined,
      true,
      'INSTALLMENT',
    );
    expect(createSignedUrlForPath).toHaveBeenCalledWith('r/1');
    expect(res[0].receiptSignedUrl).toBe('https://signed');
  });

  it('skips signing when the receiptType filter excludes the payment', async () => {
    findMany.mockResolvedValue([
      row({ receiptUrl: 'r/1', paymentType: 'INSTALLMENT' }),
    ]);
    const res = await service.getHistory(
      'u1',
      UserRole.PARENT,
      undefined,
      true,
      'FIRST_PAYMENT',
    );
    expect(createSignedUrlForPath).not.toHaveBeenCalled();
    expect(res[0].receiptSignedUrl).toBeNull();
  });

  it('leaves the signed URL null when the payment has no receipt', async () => {
    findMany.mockResolvedValue([row({ receiptUrl: null })]);
    const res = await service.getHistory(
      'u1',
      UserRole.PARENT,
      undefined,
      true,
      'ALL',
    );
    expect(createSignedUrlForPath).not.toHaveBeenCalled();
    expect(res[0].receiptSignedUrl).toBeNull();
  });

  it('degrades gracefully to null when signing throws (object gone)', async () => {
    createSignedUrlForPath.mockRejectedValue(new Error('gone'));
    findMany.mockResolvedValue([
      row({ receiptUrl: 'r/1', paymentType: 'FIRST_PAYMENT' }),
    ]);
    const res = await service.getHistory(
      'u1',
      UserRole.PARENT,
      undefined,
      true,
      'ALL',
    );
    expect(res[0].receiptSignedUrl).toBeNull();
  });
});

describe('PaymentService.updateRemainingBalance — below-fee edge', () => {
  let service: PaymentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        {
          provide: PrismaService,
          useValue: { payment: { findMany: jest.fn() } },
        },
        {
          provide: DocumentsService,
          useValue: { createSignedUrlForPath: jest.fn() },
        },
      ],
    }).compile();
    service = module.get<PaymentService>(PaymentService);
  });

  it('floors the school-credited deposit at zero when it is below the platform fee', () => {
    // platformFee(100_000) = 2_500; a 1_000 deposit is entirely consumed by the
    // fee → effectiveDepositToSchool floored to 0, so the full fee still remains.
    expect(service.updateRemainingBalance(100_000, 1_000, 0)).toBe(100_000);
  });
});
