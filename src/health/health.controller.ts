import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';
import { FIREBASE_STORAGE } from '../firebase/firebase.module';
import { Prisma } from '../generated/prisma/client';
import type { Storage } from 'firebase-admin/storage';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(FIREBASE_STORAGE) private readonly storage: Storage,
  ) {}

  @Public()
  @Get()
  async getHealth(@Res({ passthrough: true }) res: Response) {
    const nodeEnv = this.config.get<string>('NODE_ENV') ?? 'development';
    const appOk = true;

    let dbOk = false;
    let dbError: string | undefined;
    try {
      await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
      dbOk = true;
    } catch (e: any) {
      dbOk = false;
      dbError = e?.message ?? 'db_error';
    }

    const bucketName =
      this.config.get<string>('FIREBASE_STORAGE_BUCKET') ?? '';

    let storageOk = false;
    let storageError: string | undefined;
    try {
      const [exists] = await Promise.race([
        this.storage.bucket(bucketName).exists(),
        new Promise<[boolean]>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000),
        ),
      ]);
      storageOk = exists;
    } catch (e: any) {
      storageOk = false;
      storageError = e?.message ?? 'storage_error';
    }

    if (!dbOk) {
      res.status(503);
    }

    return {
      status: dbOk && storageOk ? 'ok' : 'degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      nodeEnv,
      checks: {
        app: { ok: appOk },
        db: { ok: dbOk, error: dbError },
        storage: { ok: storageOk, bucket: bucketName, error: storageError },
      },
    };
  }
}
