// src/services/payment.service.ts

import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, UserRole } from '../generated/prisma/client';
import { DocumentsService } from '../documents/documents.service';

export type InstallmentPlan = 'WEEKLY' | 'MONTHLY';
export type ChildPaymentStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'DEFAULTED';

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

export type PaymentPlan = {
  type: 'Weekly' | 'Monthly';
  frequencyLabel: string;
  numberOfPayments: number;
  baseAmount: number;
  totalAmount: number;
};

export type PaymentStructureResult = {
  originalAmount: number;
  platformFeeAmount: number;
  totalPayable: number; // originalAmount + platformFeeAmount
  depositAmount: number;
  totalInitialPayment: number; // deposit + platformFee
  depositPercentage: number;
  remainingBalance: number;
  platformFeePercentage: number;
  plans: PaymentPlan[];
};

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentsService: DocumentsService,
  ) {}

  /** Calculate comprehensive payment structure */
  calculatePaymentStructure(totalAmount: number): PaymentStructureResult {
    // Strict validation to prevent NaN/undefined bypassing the check
    // src/services/payment.service.ts
    if (!totalAmount || Number.isNaN(totalAmount) || totalAmount <= 0) {
      throw new BadRequestException(
        'Invalid total amount. Please provide a valid positive number.',
      );
    }

    const DEPOSIT_PERCENTAGE = 0.25;
    const PLATFORM_FEE_PERCENTAGE = 0.025; // 2.5%

    const depositAmount = totalAmount * DEPOSIT_PERCENTAGE;

    // Calculate fees and totals exactly as requested
    const platformFeeAmount = totalAmount * PLATFORM_FEE_PERCENTAGE;
    const totalPayable = totalAmount + platformFeeAmount;
    const totalInitialPayment = depositAmount + platformFeeAmount;

    // Remaining balance = Total Payable - Total Initial Payment
    const remainingBalance = totalPayable - totalInitialPayment;

    // Helper to create plan
    const createPlan = (
      type: 'Weekly' | 'Monthly',
      label: string,
      count: number,
    ): PaymentPlan => {
      const baseAmount = remainingBalance / count;
      // Service fee is 0 for installments (already paid upfront)
      return {
        type,
        frequencyLabel: label,
        numberOfPayments: count,
        baseAmount: Number(baseAmount.toFixed(2)),
        totalAmount: Number(baseAmount.toFixed(2)),
      };
    };

    return {
      originalAmount: totalAmount,
      platformFeeAmount: Number(platformFeeAmount.toFixed(2)),
      totalPayable: Number(totalPayable.toFixed(2)),
      depositAmount: Number(depositAmount.toFixed(2)),
      totalInitialPayment: Number(totalInitialPayment.toFixed(2)),
      depositPercentage: DEPOSIT_PERCENTAGE,
      remainingBalance: Number(remainingBalance.toFixed(2)),
      platformFeePercentage: PLATFORM_FEE_PERCENTAGE,
      plans: [
        createPlan('Weekly', '/ week', 12),
        createPlan('Monthly', '/ month', 3),
      ],
    };
  }

  /** Calculate initial deposit and platform fee */
  calculateInitialPayment(
    schoolFees: number,
    depositPaid: number,
  ): DepositCalculationResult {
    if (schoolFees <= 0) throw new BadRequestException('Invalid school fees');

    const PLATFORM_FEE_PERCENT = 0.025;
    const SCHOOL_FIRST_PAYMENT_PERCENT = 0.25;

    const platformFee = schoolFees * PLATFORM_FEE_PERCENT; // 2.5%
    const schoolShare = schoolFees * SCHOOL_FIRST_PAYMENT_PERCENT; // 25%

    // Minimum payment includes both school first payment + platform fee
    const minimumDeposit = schoolShare + platformFee;

    if (depositPaid < minimumDeposit) {
      // Allow for small floating point differences (e.g. 0.01)
      if (Math.abs(depositPaid - minimumDeposit) > 0.1) {
        throw new BadRequestException(
          `Deposit is below minimum required. Minimum first payment: ₦${minimumDeposit.toFixed(2)}`,
        );
      }
    }

    // IMPORTANT: The platform fee is deducted first. The rest goes to the school.
    const amountToSchool = depositPaid - platformFee;

    // Remaining Balance is School Fees - Amount paid TO SCHOOL (excluding platform fee)
    const remainingBalance = schoolFees - amountToSchool;

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
  calculateInstallments(
    remainingBalance: number,
    plan: InstallmentPlan,
  ): InstallmentCalculationResult {
    if (remainingBalance <= 0)
      throw new BadRequestException('No balance to calculate installments');

    let numberOfInstallments: number;

    switch (plan) {
      case 'WEEKLY':
        numberOfInstallments = 12; // 3 months ≈ 12 weeks
        break;
      case 'MONTHLY':
        numberOfInstallments = 3; // 3 months
        break;
      default:
        throw new BadRequestException('Invalid installment plan');
    }

    const installmentAmount = remainingBalance / numberOfInstallments;

    return {
      totalBalance: remainingBalance,
      numberOfInstallments,
      installmentAmount,
      plan,
    };
  }

  /** Update remaining balance after each installment */
  updateRemainingBalance(
    schoolFees: number,
    depositPaid: number,
    installmentsPaid: number,
  ): number {
    // We assume depositPaid INCLUDES the platform fee.
    // We must deduct the platform fee to find what was actually paid towards the school fees.
    const platformFee = schoolFees * 0.025;

    // Check if deposit was enough to cover platform fee (it should be, based on validation)
    const effectiveDepositToSchool = Math.max(0, depositPaid - platformFee);

    const totalPaidToSchool = effectiveDepositToSchool + installmentsPaid;
    const remainingBalance = schoolFees - totalPaidToSchool;

    return Math.max(remainingBalance, 0);
  }

  /** Determine the next payment status based on current conditions */
  getNextStatus(
    currentStatus: ChildPaymentStatus,
    depositPaid: number,
    depositConfirmedBySchool: boolean,
    remainingBalance: number,
    isOverdue: boolean,
  ): ChildPaymentStatus {
    if (currentStatus === 'DEFAULTED') return 'DEFAULTED';
    if (remainingBalance <= 0) return 'COMPLETED';
    if (isOverdue) return 'DEFAULTED';
    if (depositConfirmedBySchool) return 'ACTIVE';
    return 'PENDING';
  }

  async getHistory(
    userId: string,
    role: UserRole,
    schoolId?: string,
    includeReceiptSignedUrls = false,
    receiptType: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT' = 'ALL',
  ) {
    let whereClause: Prisma.PaymentWhereInput = {};

    if (role === UserRole.PARENT) {
      whereClause = {
        enrollment: { child: { parent: { userId } } },
      };
    } else if (role === UserRole.SCHOOL_OWNER) {
      if (!schoolId) {
        throw new Error('School ID is required for school owners');
      }
      whereClause = { schoolId };
    }

    const payments = await this.prisma.payment.findMany({
      where: whereClause,
      include: {
        enrollment: {
          include: {
            child: true,
            school: true,
          },
        },
      },
      orderBy: { paymentDate: 'desc' },
    });

    if (!includeReceiptSignedUrls) {
      return payments.map((p) => ({
        ...p,
        status: p.status,
        studentName: p.enrollment?.child?.fullName,
        className: p.enrollment?.className,
        schoolName: p.enrollment?.school?.name,
      }));
    }

    const shouldSign = (paymentType: string) =>
      receiptType === 'ALL' || paymentType === receiptType;

    const enriched = await Promise.all(
      payments.map(async (p) => {
        let receiptSignedUrl: string | null = null;
        if (p.receiptUrl && shouldSign(p.paymentType)) {
          try {
            receiptSignedUrl = (
              await this.documentsService.createSignedUrlForPath(p.receiptUrl)
            ).signedUrl;
          } catch {
            // If the object no longer exists in storage, don't fail the whole list.
            receiptSignedUrl = null;
          }
        }

        return {
          ...p,
          status: p.status,
          studentName: p.enrollment?.child?.fullName,
          className: p.enrollment?.className,
          schoolName: p.enrollment?.school?.name,
          receiptSignedUrl,
        };
      }),
    );

    return enriched;
  }
}
