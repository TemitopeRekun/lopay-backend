import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PrismaService } from '../prisma/prisma.service';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
import * as admin from 'firebase-admin';
import { RolesGuard } from './roles.guard';
import { FirebaseAdminProvider } from 'src/firebase/firebase-admin.provider';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'supersecretkey', // Use env variable
      signOptions: { expiresIn: '1h' },
    }),
  ],
  providers: [
    FirebaseAdminProvider,
    AuthService,
    PrismaService,
    JwtStrategy,
    RolesGuard,
  ],
  controllers: [AuthController],
  exports: [FirebaseAdminProvider, AuthService, JwtStrategy, RolesGuard],
})
export class AuthModule {}
