import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PrismaService } from '../prisma/prisma.service';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
import * as admin from 'firebase-admin';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'supersecretkey', // Use env variable
      signOptions: { expiresIn: '1h' },
    }),
  ],
  providers: [AuthService, PrismaService, JwtStrategy, RolesGuard],
  controllers: [AuthController],
  exports: [AuthService, JwtStrategy, RolesGuard],
})
export class AuthModule {
  constructor() {
    // Initialize Firebase admin SDK
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
}
