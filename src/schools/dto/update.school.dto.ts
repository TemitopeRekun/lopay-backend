import { IsString, IsOptional, IsEmail } from 'class-validator';

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

  @IsString()
  @IsOptional()
  accountName?: string;

  @IsString()
  @IsOptional()
  accountNumber?: string;
}
