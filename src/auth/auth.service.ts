import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '../../generated/client/client';

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

    // 1. Validate that the Firebase token contains an email.
    if (!email) {
      throw new UnauthorizedException('Firebase token is missing email.');
    }

    // Check if user exists in DB
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      include: { school: true },
    });

    // If user does not exist, create a new one.
    const user =
      existingUser ||
      (await this.prisma.user.create({
        data: {
          email, // This is now guaranteed to be a string.
          password: 'firebase-auth-user', // Placeholder, we rely on Firebase
          role: UserRole.PARENT,
        },
        // 2. Ensure `include` is here so the created user object also has the `school` relation.
        include: { school: true },
      }));

    console.log('User authenticated successfully:', user.id);
    // Create backend JWT
    const payload = {
      sub: user.id,
      role: user.role,
      schoolId: user.school?.id ?? null, // This will now work correctly.
    };

    return {
      accessToken: this.jwtService.sign(payload),
    };
  }
}
