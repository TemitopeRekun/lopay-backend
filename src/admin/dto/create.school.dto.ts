import { IsString, IsEmail, IsNotEmpty, IsOptional, MinLength } from 'class-validator';

export class CreateSchoolDto {
  @IsString()
  @IsNotEmpty()
  schoolName: string;

  @IsEmail()
  @IsNotEmpty()
  ownerEmail: string;

  @IsString()
  @MinLength(6)
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