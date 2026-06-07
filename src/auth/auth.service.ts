import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '../generated/prisma/client';
import { RegisterDto } from './dto/register.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject('FIREBASE_ADMIN')
    private readonly firebase: typeof import('firebase-admin'),
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /** Register a new user */
  async register(dto: RegisterDto) {
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    // 0. Pre-check: Ensure user doesn't already exist in DB
    // This prevents "orphan" Firebase accounts if DB creation fails later
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new BadRequestException('Email already exists');
    }

    let firebaseUser;
    try {
      // 1. Create User in Firebase
      firebaseUser = await this.firebase.auth().createUser({
        email: dto.email,
        password: dto.password,
      });

      // 2. Create User in Database — ID intentionally synced to Firebase UID
      const user = await this.prisma.user.create({
        data: {
          id: firebaseUser.uid,
          email: dto.email,
          fullName: dto.fullName,
          role: UserRole.PARENT,
          parent: {
            create: {
              phoneNumber: dto.phoneNumber,
            },
          },
        },
      });

      // 3. Generate Token
      const payload = {
        sub: user.id,
        role: user.role,
        schoolId: null,
      };

      return {
        message: 'User registered successfully',
        accessToken: this.jwtService.sign(payload),
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          fullName: user.fullName,
        },
      };
    } catch (error) {
      this.logger.error('Registration failed', error instanceof Error ? error.stack : String(error));

      if (firebaseUser) {
        this.logger.warn(`Rolling back Firebase user creation for: ${firebaseUser.uid}`);
        await this.firebase
          .auth()
          .deleteUser(firebaseUser.uid)
          .catch((rollbackError: Error) => {
            this.logger.error('Firebase rollback failed', rollbackError.stack);
          });
      }

      if (error.code === 'auth/email-already-exists') {
        throw new BadRequestException('Email already exists');
      }

      // If user created in Firebase but DB failed, we might want to rollback (delete from Firebase).
      // For MVP, we'll just throw.
      throw new BadRequestException(error.message);
    }
  }

  /** Verify Firebase token & issue backend JWT */
  async loginWithFirebase(idToken: string) {
    const decodedToken = await this.firebase
      .auth()
      .verifyIdToken(idToken)
      .catch((error: Error) => {
        this.logger.warn(`Token verification failed: ${error.message}`);
        throw new UnauthorizedException('Invalid Firebase token');
      });
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

    // If the user does not exist in the DB they have not completed registration.
    // Reject rather than silently creating a bare-bones record with a mismatched ID.
    if (!existingUser) {
      throw new UnauthorizedException(
        'Account not found. Please register before logging in.',
      );
    }

    const user = existingUser;

    // Create backend JWT
    const payload = {
      sub: user.id,
      role: user.role,
      schoolId: user.school?.id ?? null, // This will now work correctly.
    };

    return {
      message: 'Login successful',
      accessToken: this.jwtService.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        fullName: user.fullName,
      },
    };
  }
}
