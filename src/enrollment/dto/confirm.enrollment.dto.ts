import { IsUUID } from 'class-validator';

export class ConfirmEnrollmentDto {
  @IsUUID()
  enrollmentId: string;
}