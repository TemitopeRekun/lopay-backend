import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentsService } from '../documents/documents.service';

const mockPrisma = { payment: { findMany: jest.fn() } };
const mockDocuments = { createSignedUrlForPath: jest.fn() };

describe('PaymentService', () => {
  let service: PaymentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: DocumentsService, useValue: mockDocuments },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── calculatePaymentStructure ────────────────────────────────────────────

  describe('calculatePaymentStructure', () => {
    it('returns correct structure for a round amount', () => {
      const result = service.calculatePaymentStructure(100_000);

      expect(result.originalAmount).toBe(100_000);
      expect(result.platformFeeAmount).toBeCloseTo(2_500, 2);     // 2.5%
      expect(result.totalPayable).toBeCloseTo(102_500, 2);        // + platform fee
      expect(result.depositAmount).toBeCloseTo(25_000, 2);        // 25%
      expect(result.totalInitialPayment).toBeCloseTo(27_500, 2);  // deposit + platform fee
      expect(result.remainingBalance).toBeCloseTo(75_000, 2);     // totalPayable - initial
      expect(result.plans).toHaveLength(2);
    });

    it('weekly plan has 12 instalments', () => {
      const result = service.calculatePaymentStructure(120_000);
      const weekly = result.plans.find((p) => p.type === 'Weekly');
      expect(weekly).toBeDefined();
      expect(weekly!.numberOfPayments).toBe(12);
    });

    it('monthly plan has 3 instalments', () => {
      const result = service.calculatePaymentStructure(120_000);
      const monthly = result.plans.find((p) => p.type === 'Monthly');
      expect(monthly).toBeDefined();
      expect(monthly!.numberOfPayments).toBe(3);
    });

    it('throws on zero amount', () => {
      expect(() => service.calculatePaymentStructure(0)).toThrow(BadRequestException);
    });

    it('throws on negative amount', () => {
      expect(() => service.calculatePaymentStructure(-1000)).toThrow(BadRequestException);
    });

    it('throws on NaN', () => {
      expect(() => service.calculatePaymentStructure(NaN)).toThrow(BadRequestException);
    });
  });

  // ─── calculateInitialPayment ──────────────────────────────────────────────

  describe('calculateInitialPayment', () => {
    it('returns correct split for exact minimum deposit', () => {
      // schoolFees = 100_000 → platformFee = 2_500, schoolShare = 25_000, minimumDeposit = 27_500
      const result = service.calculateInitialPayment(100_000, 27_500);

      expect(result.platformFee).toBeCloseTo(2_500, 2);
      expect(result.minimumDeposit).toBeCloseTo(27_500, 2);
      expect(result.amountToSchool).toBeCloseTo(25_000, 2);  // depositPaid - platformFee
      expect(result.remainingBalance).toBeCloseTo(75_000, 2); // schoolFees - amountToSchool
    });

    it('accepts deposits above the minimum', () => {
      const result = service.calculateInitialPayment(100_000, 50_000);
      expect(result.amountToSchool).toBeCloseTo(47_500, 2); // 50_000 - 2_500 platform fee
    });

    it('throws when deposit is materially below minimum', () => {
      expect(() => service.calculateInitialPayment(100_000, 10_000)).toThrow(BadRequestException);
    });

    it('throws on zero school fees', () => {
      expect(() => service.calculateInitialPayment(0, 0)).toThrow(BadRequestException);
    });
  });

  // ─── calculateInstallments ────────────────────────────────────────────────

  describe('calculateInstallments', () => {
    it('splits into 12 for WEEKLY plan', () => {
      const result = service.calculateInstallments(75_000, 'WEEKLY');
      expect(result.numberOfInstallments).toBe(12);
      expect(result.installmentAmount).toBeCloseTo(6_250, 2);
    });

    it('splits into 3 for MONTHLY plan', () => {
      const result = service.calculateInstallments(75_000, 'MONTHLY');
      expect(result.numberOfInstallments).toBe(3);
      expect(result.installmentAmount).toBeCloseTo(25_000, 2);
    });

    it('throws on zero remaining balance', () => {
      expect(() => service.calculateInstallments(0, 'WEEKLY')).toThrow(BadRequestException);
    });
  });

  // ─── getNextStatus ────────────────────────────────────────────────────────

  describe('getNextStatus', () => {
    it('stays DEFAULTED once defaulted', () => {
      expect(service.getNextStatus('DEFAULTED', 1000, true, 0, false)).toBe('DEFAULTED');
    });

    it('returns COMPLETED when balance reaches zero', () => {
      expect(service.getNextStatus('ACTIVE', 1000, true, 0, false)).toBe('COMPLETED');
    });

    it('returns DEFAULTED when overdue', () => {
      expect(service.getNextStatus('ACTIVE', 1000, true, 5000, true)).toBe('DEFAULTED');
    });

    it('returns ACTIVE when deposit confirmed and balance remains', () => {
      expect(service.getNextStatus('PENDING', 1000, true, 5000, false)).toBe('ACTIVE');
    });

    it('returns PENDING when deposit not yet confirmed', () => {
      expect(service.getNextStatus('PENDING', 1000, false, 5000, false)).toBe('PENDING');
    });
  });

  // ─── updateRemainingBalance ───────────────────────────────────────────────

  describe('updateRemainingBalance', () => {
    it('correctly reduces balance after deposit and installments', () => {
      // schoolFees=100k, depositPaid=27.5k (includes 2.5k platform fee → 25k to school)
      // After 2 installments of 12.5k each → 25k paid
      const balance = service.updateRemainingBalance(100_000, 27_500, 25_000);
      expect(balance).toBeCloseTo(50_000, 2);
    });

    it('never returns a negative balance', () => {
      const balance = service.updateRemainingBalance(100_000, 200_000, 0);
      expect(balance).toBe(0);
    });
  });
});
