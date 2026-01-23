import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  /** Login using Firebase ID token */
  @Post('login')
  async login(@Body('idToken') idToken: string) {
    return this.authService.loginWithFirebase(idToken);
  }
}
