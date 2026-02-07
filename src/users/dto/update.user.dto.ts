import { IsString, IsOptional, IsEmail, IsEnum } from 'class-validator';
import { UserRole } from '../../generated/prisma/client';

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  fullName?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;
}
