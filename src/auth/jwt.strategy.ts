import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configService.get<string>('JWT_SECRET') || 'supersecretkey',
    });
  }

  async validate(payload: any) {
    console.log('JwtStrategy validating payload:', payload);
    // Request will have user info in req.user
    return {
       userId: payload.sub,
      role: payload.role,
      schoolId: payload.schoolId ?? null,
    }
  }
}
