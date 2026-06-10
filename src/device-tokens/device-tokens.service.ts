import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';

@Injectable()
export class DeviceTokensService {
  constructor(private readonly prisma: PrismaService) {}

  async register(userId: string, dto: RegisterDeviceTokenDto) {
    // Reassign userId on conflict: a single device (token) may be re-used by a
    // different account after re-login, and pushes must follow the current owner.
    return this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      update: { userId, platform: dto.platform },
      create: {
        userId,
        token: dto.token,
        platform: dto.platform,
      },
    });
  }

  async unregister(userId: string, token: string) {
    // Scope the delete to the caller so a user can't unregister another's token.
    await this.prisma.deviceToken.deleteMany({ where: { token, userId } });
  }

  async getTokensForUser(userId: string) {
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });
    return tokens.map((t) => t.token);
  }
}
