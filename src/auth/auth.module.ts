import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PrismaService } from '../prisma/prisma.service';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
import * as admin from 'firebase-admin';
import { RolesGuard } from './roles.guard';
import { FirebaseAdminProvider } from '../firebase/firebase-admin.provider';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') || 'supersecretkey',
        signOptions: { expiresIn: '1h' },
      }),
      inject: [ConfigService],
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
