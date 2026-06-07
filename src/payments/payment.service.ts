// src/services/payment.service.ts

import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, UserRole } from '../generated/prisma/client';
import { DocumentsService } from '../documents/documents.service';
import { Money } from '../common/money';

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

  /**
   * Calculate comprehensive payment structure for the public calculator endpoint.
   * Accepts and returns Naira — no DB storage; pure display calculation.
   * Uses Money internally so intermediate values are exact integer kobo.
   */
  calculatePaymentStructure(totalAmount: number): PaymentStructureResult {
    if (!totalAmount || Number.isNaN(totalAmount) || totalAmount <= 0) {
      throw new BadRequestException(
        'Invalid total amount. Please provide a valid positive number.',
      );
    }

    const DEPOSIT_PERCENTAGE = 0.25;
    const PLATFORM_FEE_PERCENTAGE = 0.025;

    const total = Money.fromNaira(totalAmount);
    const platformFee = total.percent(PLATFORM_FEE_PERCENTAGE);
    const deposit = total.percent(DEPOSIT_PERCENTAGE);
    const totalPayable = total.add(platformFee);
    const totalInitialPayment = deposit.add(platformFee);
    const remainingBalance = totalPayable.subtract(totalInitialPayment);

    const createPlan = (
      type: 'Weekly' | 'Monthly',
      label: string,
      count: number,
    ): PaymentPlan => {
      const installmentKobo = Math.round(remainingBalance.toKobo() / count);
      const installmentNaira = installmentKobo / 100;
      return {
        type,
        frequencyLabel: label,
        numberOfPayments: count,
        baseAmount: installmentNaira,
        totalAmount: installmentNaira,
      };
    };

    return {
      originalAmount: totalAmount,
      platformFeeAmount: platformFee.toNaira(),
      totalPayable: totalPayable.toNaira(),
      depositAmount: deposit.toNaira(),
      totalInitialPayment: totalInitialPayment.toNaira(),
      depositPercentage: DEPOSIT_PERCENTAGE,
      remainingBalance: remainingBalance.toNaira(),
      platformFeePercentage: PLATFORM_FEE_PERCENTAGE,
      plans: [
        createPlan('Weekly', '/ week', 12),
        createPlan('Monthly', '/ month', 3),
      ],
    };
  }

  /**
   * Calculate the initial deposit split for enrollment.
   * Accepts and returns integer **kobo** — call sites convert Naira↔kobo at the
   * DTO/DB boundary; this method never sees floating-point Naira values.
   */
  calculateInitialPayment(
    schoolFeesKobo: number,
    depositPaidKobo: number,
  ): DepositCalculationResult {
    if (schoolFeesKobo <= 0) throw new BadRequestException('Invalid school fees');

    const PLATFORM_FEE_PERCENT = 0.025;
    const SCHOOL_FIRST_PAYMENT_PERCENT = 0.25;

    const schoolFees = Money.fromKobo(schoolFeesKobo);
    const depositPaid = Money.fromKobo(depositPaidKobo);
    const platformFee = schoolFees.percent(PLATFORM_FEE_PERCENT);
    const schoolShare = schoolFees.percent(SCHOOL_FIRST_PAYMENT_PERCENT);
    const minimumDeposit = schoolShare.add(platformFee);

    if (depositPaid.isLessThan(minimumDeposit)) {
      throw new BadRequestException(
        `Deposit is below minimum required. Minimum first payment: ${minimumDeposit.formatNaira()}`,
      );
    }

    const amountToSchool = depositPaid.subtract(platformFee);
    const remainingBalance = schoolFees.subtract(amountToSchool);

    return {
      schoolFees: schoolFees.toKobo(),
      platformFee: platformFee.toKobo(),
      minimumDeposit: minimumDeposit.toKobo(),
      depositPaid: depositPaid.toKobo(),
      amountToSchool: amountToSchool.toKobo(),
      remainingBalance: remainingBalance.toKobo(),
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
