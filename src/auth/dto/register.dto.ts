import { IsEmail, IsNotEmpty, MinLength, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'parent@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'secretPassword123', minLength: 6 })
  @IsString()
  @IsNotEmpty()
  @MinLength(6, { message: 'Password must be at least 6 characters long' })
  password: string;

  @ApiProperty({ example: 'secretPassword123' })
  @IsString()
  @IsNotEmpty()
  confirmPassword: string;

  @ApiProperty({ example: 'John Doe', description: 'Full name of the parent' })
  @IsString()
  @IsNotEmpty()
  fullName: string;

  @ApiProperty({ example: '08012345678', description: 'Phone number of the parent' })
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;
}