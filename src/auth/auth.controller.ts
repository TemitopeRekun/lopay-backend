import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from '../common/decorators/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Login using Firebase ID token */
  @Public()
  @Post('login')
  async login(@Body('idToken') idToken: string) {
    return this.authService.loginWithFirebase(idToken);
  }
}
