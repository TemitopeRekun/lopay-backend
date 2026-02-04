import { Inject, Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '../generated/prisma/client';
import { RegisterDto } from './dto/register.dto';

@Injectable()
export class AuthService {
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

    try {
      // 1. Create User in Firebase
      const firebaseUser = await this.firebase.auth().createUser({
        email: dto.email,
        password: dto.password,
      });

      // 2. Create User in Database
      const user = await this.prisma.user.create({
        data: {
          id: firebaseUser.uid, // Sync UID with Firebase
          email: dto.email,
          fullName: dto.fullName, // Save full name
          password: 'firebase-auth-user', // Placeholder
          role: UserRole.PARENT, // Default role
          // Automatically create Parent profile with phone number
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
        user,
      };
    } catch (error) {
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
