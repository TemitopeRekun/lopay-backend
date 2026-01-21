import { InstallmentFrequency } from '../../../generated/client/client';

export class CreateEnrollmentDto {
  childId: string;
  schoolId: string;
  className: string;

  installmentFrequency: InstallmentFrequency;

  firstPaymentPaid: number;
  termStartDate: Date;
  termEndDate: Date;
}
