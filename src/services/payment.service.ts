export type DepositCalculationResult = {
  schoolFees: number;
  platformFee: number;
  minimumDeposit: number;
  depositPaid: number;
  amountToSchool: number;
  remainingBalance: number;
};

export function calculateInitialPayment(
  schoolFees: number,
  depositPaid: number
): DepositCalculationResult {
  if (schoolFees <= 0) {
    throw new Error("Invalid school fees");
  }

  const platformFee = schoolFees * 0.025;
  const minimumDeposit = schoolFees * 0.25;

  if (depositPaid < minimumDeposit) {
    throw new Error("Deposit is below minimum required (25%)");
  }

  // Amount to school is depositPaid minus platform fee
  const amountToSchool = depositPaid - platformFee;
  const remainingBalance = schoolFees - depositPaid;

  return {
    schoolFees,
    platformFee,
    minimumDeposit,
    depositPaid,
    amountToSchool,
    remainingBalance,
  };
}
