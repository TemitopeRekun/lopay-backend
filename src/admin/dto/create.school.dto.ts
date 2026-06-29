import {
  IsString,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  MinLength,
} from 'class-validator';

export class CreateSchoolDto {
  @IsString()
  @IsNotEmpty()
  schoolName: string;

  @IsEmail()
  @IsNotEmpty()
  ownerEmail: string;

  // Must match Better Auth's minPasswordLength (8); a shorter value passes DTO
  // validation but is then rejected by Better Auth on owner account creation.
  @IsString()
  @MinLength(8)
  ownerPassword: string;

  @IsString()
  @IsNotEmpty()
  ownerName: string;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty()
  bankName: string;

  // Paystack settlement bank code (e.g. "058"); required to create the subaccount.
  @IsString()
  @IsNotEmpty()
  bankCode: string;

  @IsString()
  @IsNotEmpty()
  accountName: string;

  @IsString()
  @IsNotEmpty()
  accountNumber: string;

  @IsString()
  @IsOptional()
  logo?: string;
}
