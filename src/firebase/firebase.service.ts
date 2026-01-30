import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';


@Injectable()
export class AuthService {
  constructor(
    @Inject('FIREBASE_ADMIN')
    private readonly firebase: typeof import('firebase-admin'),
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async loginWithFirebase(idToken: string) {
    const decoded = await this.firebase.auth().verifyIdToken(idToken);

    const user = await this.prisma.user.findUnique({
      where: { email: decoded.email },
      include: { school: true },
    });

    if (!user) {
      throw new UnauthorizedException('User not registered on platform');
    }

    return {
      accessToken: this.jwtService.sign({
        sub: user.id,
        role: user.role,
        schoolId: user.school?.id ?? null,
      }),
    };
  }
}
