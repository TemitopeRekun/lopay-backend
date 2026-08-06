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
    // Receipts are uploaded straight from the browser to Supabase via a signed
    // URL, so the bucket's own configuration — not any code in this repo — is
    // what actually enforces size and MIME limits, and what decides whether the
    // objects are world-readable. Nothing else asserts it, so an unlimited or
    // public receipts bucket would be invisible until it mattered. Report it.
    const storageConfigIssues: string[] = [];
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
        if (data) {
          if (data.public) {
            storageConfigIssues.push(
              'bucket_is_public (receipts expose payer bank details)',
            );
          }
          if (!data.file_size_limit) {
            storageConfigIssues.push('no_file_size_limit');
          }
          if (!data.allowed_mime_types?.length) {
            storageConfigIssues.push('no_allowed_mime_types');
          }
        }
      } catch (e: unknown) {
        storageOk = false;
        storageError = errorMessage(e, 'storage_error');
      }
    }
    const storageConfigOk = storageOk && storageConfigIssues.length === 0;

    if (!dbOk) {
      res.status(503);
    }

    return {
      // Config issues do not gate reachability: uploads still work, so this
      // stays out of `storage.ok` and out of the 503 above. It is reported so a
      // misconfigured bucket is visible on the same page everything else is.
      status: dbOk && storageConfigOk ? 'ok' : 'degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      nodeEnv,
      checks: {
        app: { ok: appOk },
        db: { ok: dbOk, error: dbError },
        storage: {
          ok: storageOk,
          bucket: bucketName,
          error: storageError,
          config: {
            ok: storageConfigOk,
            issues: storageConfigIssues,
          },
        },
      },
    };
  }
}
