// src/services/payment.service.ts

import { Injectable } from '@nestjs/common';

export type InstallmentPlan = 'WEEKLY' | 'MONTHLY';
export type ChildPaymentStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'DEFAULTED';

export type DepositCalculationResult = {
  schoolFees: number;
  platformFee: number;
  minimumDeposit: number;
  depositPaid: number;
  amountToSchool: number;
  remainingBalance: number;
};

export type InstallmentCalculationResult = {
  totalBalance: number;
  numberOfInstallments: number;
  installmentAmount: number;
  plan: InstallmentPlan;
};

@Injectable()
export class PaymentService {

  /** Calculate initial deposit and platform fee */
 calculateInitialPayment(schoolFees: number, depositPaid: number): DepositCalculationResult {
  if (schoolFees <= 0) throw new Error("Invalid school fees");

  const PLATFORM_FEE_PERCENT = 0.025;
  const SCHOOL_FIRST_PAYMENT_PERCENT = 0.25;

  const platformFee = schoolFees * PLATFORM_FEE_PERCENT; // 2.5%
  const schoolShare = schoolFees * SCHOOL_FIRST_PAYMENT_PERCENT; // 25%

  // Minimum payment includes both school first payment + platform fee
  const minimumDeposit = schoolShare + platformFee;

  if (depositPaid < minimumDeposit) {
    throw new Error(
      `Deposit is below minimum required. Minimum first payment: ₦${minimumDeposit.toFixed(2)}`
    );
  }

  const amountToSchool = depositPaid - platformFee; // School gets remaining after platform fee
  const remainingBalance = schoolFees - depositPaid; // balance for installment

  return {
    schoolFees,
    platformFee,
    minimumDeposit,
    depositPaid,
    amountToSchool,
    remainingBalance,
  };
}


  /** Calculate installment amounts based on remaining balance */
  calculateInstallments(remainingBalance: number, plan: InstallmentPlan): InstallmentCalculationResult {
    if (remainingBalance <= 0) throw new Error("No balance to calculate installments");

    let numberOfInstallments: number;

    switch (plan) {
      case 'WEEKLY':
        numberOfInstallments = 12; // 3 months ≈ 12 weeks
        break;
      case 'MONTHLY':
        numberOfInstallments = 3; // 3 months
        break;
      default:
        throw new Error("Invalid installment plan");
    }

    const installmentAmount = remainingBalance / numberOfInstallments;

    return {
      totalBalance: remainingBalance,
      numberOfInstallments,
      installmentAmount,
      plan
    };
  }

  /** Update remaining balance after each installment */
  updateRemainingBalance(schoolFees: number, depositPaid: number, installmentsPaid: number): number {
    const totalPaid = depositPaid + installmentsPaid;
    const remainingBalance = schoolFees - totalPaid;
    return Math.max(remainingBalance, 0);
  }

  /** Determine the next payment status based on current conditions */
  getNextStatus(
    currentStatus: ChildPaymentStatus,
     depositPaid: number,
    depositConfirmedBySchool: boolean,
    remainingBalance: number,
    isOverdue: boolean
  ): ChildPaymentStatus {

    switch (currentStatus) {
      case 'PENDING':
        if (depositConfirmedBySchool) return 'ACTIVE';
        return 'PENDING';

      case 'ACTIVE':
        if (remainingBalance <= 0) return 'COMPLETED';
        if (isOverdue) return 'DEFAULTED';
        return 'ACTIVE';

      case 'COMPLETED':
        return 'COMPLETED';

      case 'DEFAULTED':
        if (remainingBalance <= 0) return 'COMPLETED';
        return 'DEFAULTED';

      default:
        throw new Error('Unknown current status');
    }
  }
}
