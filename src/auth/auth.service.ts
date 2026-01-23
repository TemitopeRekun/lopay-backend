import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as admin from 'firebase-admin';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  /** Verify Firebase token & issue backend JWT */
  async loginWithFirebase(idToken: string) {
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const { email, uid } = decodedToken;

      // Check if user exists in DB
      const user = await this.prisma.user.findUnique({ where: { email } });
      if (!user) {
        throw new UnauthorizedException('User not found in system');
      }

      // Create backend JWT
      const payload = {
        sub: user.id,
        role: user.role,
        schoolId: user.school?.id || null,
      };

      return {
        accessToken: this.jwtService.sign(payload),
      };
    } catch (error) {
      throw new UnauthorizedException('Invalid Firebase token');
    }
  }
}
