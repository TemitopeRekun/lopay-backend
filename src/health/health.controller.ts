import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';
import { SUPABASE_CLIENT } from '../supabase/supabase.module';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Prisma } from '../generated/prisma/client';
import { errorMessage } from '../common/errors';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient | null,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness/readiness check (app, DB, storage)' })
  async getHealth(@Res({ passthrough: true }) res: Response) {
    const nodeEnv = this.config.get<string>('NODE_ENV') ?? 'development';
    const appOk = true;

    let dbOk = false;
    let dbError: string | undefined;
    try {
      await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
      dbOk = true;
    } catch (e: unknown) {
      dbOk = false;
      dbError = errorMessage(e, 'db_error');
    }

    const bucketName =
      this.config.get<string>('SUPABASE_STORAGE_BUCKET') ?? 'receipts';

    let storageOk = false;
    let storageError: string | undefined;
    if (!this.supabase) {
      storageError = 'not_configured';
    } else {
      try {
        const { data, error } = await Promise.race([
          this.supabase.storage.getBucket(bucketName),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 2000),
          ),
        ]);
        storageOk = !error && !!data;
        if (error) storageError = errorMessage(error, 'storage_error');
      } catch (e: unknown) {
        storageOk = false;
        storageError = errorMessage(e, 'storage_error');
      }
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
