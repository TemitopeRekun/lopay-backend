import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    @Inject('FIREBASE_ADMIN')
    private readonly firebase: typeof import('firebase-admin'),
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /** Verify Firebase token & issue backend JWT */
  async loginWithFirebase(idToken: string) {
    console.log('Login attempt initiated with token:', idToken);
    const decodedToken = await this.firebase
      .auth()
      .verifyIdToken(idToken)
      .catch((error) => {
        console.error('Token verification failed:', error);
        throw new UnauthorizedException('Invalid Firebase token');
      });
    console.log('Token verified. Email:', decodedToken.email);
    const { email } = decodedToken;

    // Check if user exists in DB
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { school: true },
    });
    if (!user) {
      console.warn('User not found in database for email:', email);
      throw new UnauthorizedException('User not found in system');
    }
    console.log('User authenticated successfully:', user.id);
    // Create backend JWT
    const payload = {
      sub: user.id,
      role: user.role,
      schoolId: user.school?.id ?? null,
    };

    return {
      accessToken: this.jwtService.sign(payload),
    };
  }
}
