import { IsString, IsOptional } from 'class-validator';

export class UpdateSchoolDto {
  @IsString()
  @IsOptional()
  schoolName?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsOptional()
  logo?: string;

  @IsString()
  @IsOptional()
  bankName?: string;

  /**
   * Paystack bank code (e.g. "058"), from `GET /admin/paystack/banks`. Required
   * when the settlement account number changes: it is what actually identifies the
   * destination bank to Paystack, and without it the subaccount cannot be re-pointed.
   */
  @IsString()
  @IsOptional()
  bankCode?: string;

  @IsString()
  @IsOptional()
  accountName?: string;

  @IsString()
  @IsOptional()
  accountNumber?: string;
}
