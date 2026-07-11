import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsController } from './payments.controller';
import { PaymentService } from './payment.service';
import type { ChildPaymentStatus } from './payment.service';

describe('PaymentsController', () => {
  let controller: PaymentsController;

  const service = {
    calculatePaymentStructure: jest.fn().mockReturnValue({ structure: true }),
    calculateInitialPayment: jest.fn().mockReturnValue({ deposit: true }),
    calculateInstallments: jest.fn().mockReturnValue({ installments: true }),
    updateRemainingBalance: jest.fn().mockReturnValue(1234),
    getNextStatus: jest.fn().mockReturnValue('ACTIVE' as ChildPaymentStatus),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [{ provide: PaymentService, useValue: service }],
    }).compile();
    controller = module.get<PaymentsController>(PaymentsController);
  });

  describe('calculateStructure', () => {
    it('uses totalAmount when provided', () => {
      controller.calculateStructure({
        schoolId: 's1',
        totalAmount: 50000,
        feeType: 'FULL',
        grade: 'Grade 1',
      });
      expect(service.calculatePaymentStructure).toHaveBeenCalledWith(50000);
    });

    it('falls back to the legacy schoolFees field', () => {
      controller.calculateStructure({
        schoolId: 's1',
        schoolFees: 40000,
        feeType: 'FULL',
        grade: 'Grade 1',
      });
      expect(service.calculatePaymentStructure).toHaveBeenCalledWith(40000);
    });

    it('coerces a string amount to a number', () => {
      controller.calculateStructure({
        schoolId: 's1',
        totalAmount: '30000' as unknown as number,
        feeType: 'FULL',
        grade: 'Grade 1',
      });
      expect(service.calculatePaymentStructure).toHaveBeenCalledWith(30000);
    });

    it('throws when neither amount field is present', () => {
      expect(() =>
        controller.calculateStructure({
          schoolId: 's1',
          feeType: 'FULL',
          grade: 'Grade 1',
        }),
      ).toThrow('Total amount is required');
      expect(service.calculatePaymentStructure).not.toHaveBeenCalled();
    });
  });

  it('calculateDeposit delegates schoolFees and depositPaid', () => {
    const result = controller.calculateDeposit({
      schoolFees: 100000,
      depositPaid: 20000,
    });
    expect(service.calculateInitialPayment).toHaveBeenCalledWith(100000, 20000);
    expect(result).toEqual({ deposit: true });
  });

  it('calculateInstallments delegates remaining balance and plan', () => {
    controller.calculateInstallments({
      remainingBalance: 80000,
      plan: 'MONTHLY',
    });
    expect(service.calculateInstallments).toHaveBeenCalledWith(
      80000,
      'MONTHLY',
    );
  });

  it('updateBalance returns the computed remaining balance', () => {
    const result = controller.updateBalance({
      schoolFees: 100000,
      depositPaid: 20000,
      installmentsPaid: 30000,
    });
    expect(service.updateRemainingBalance).toHaveBeenCalledWith(
      100000,
      20000,
      30000,
    );
    expect(result).toEqual({ remainingBalance: 1234 });
  });

  it('updateStatus returns the computed next status', () => {
    const result = controller.updateStatus({
      currentStatus: 'PENDING',
      depositPaid: 20000,
      depositConfirmedBySchool: true,
      remainingBalance: 80000,
      isOverdue: false,
    });
    expect(service.getNextStatus).toHaveBeenCalledWith(
      'PENDING',
      20000,
      true,
      80000,
      false,
    );
    expect(result).toEqual({ newStatus: 'ACTIVE' });
  });
});
