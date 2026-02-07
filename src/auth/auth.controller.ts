import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from '../common/decorators/public.decorator';
import { RegisterDto } from './dto/register.dto';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'firebase-id-token-xyz...', description: 'Firebase ID Token' })
  @IsString()
  @IsNotEmpty()
  idToken: string;
}

@Throttle({ default: { limit: 10, ttl: 60000 } }) // Stricter limit for Auth endpoints
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Register a new user */
  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  /** Login using Firebase ID token */
  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.loginWithFirebase(dto.idToken);
  }
}