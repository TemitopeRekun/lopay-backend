import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from '../common/decorators/public.decorator';
import { RegisterDto } from './dto/register.dto';

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
  async login(@Body('idToken') idToken: string) {
    return this.authService.loginWithFirebase(idToken);
  }
}
