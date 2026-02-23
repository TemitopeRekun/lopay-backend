import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';
import { createClient } from '@supabase/supabase-js';
import { Prisma } from '../generated/prisma/client';

@Controller('healthz')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get()
  async getHealth() {
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

    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const supabaseKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = this.config.get<string>('SUPABASE_STORAGE_BUCKET');

    let storageOk = false;
    let storageError: string | undefined;
    if (!supabaseUrl || !supabaseKey || !bucket) {
      storageOk = false;
      storageError = 'missing_config';
    } else {
      try {
        const client = createClient(supabaseUrl, supabaseKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
        });
        const { data, error } = await client.storage.listBuckets();
        if (error) {
          storageOk = false;
          storageError = error.message;
        } else {
          storageOk = !!data?.find((b) => b.name === bucket);
          if (!storageOk) {
            storageError = 'bucket_not_found';
          }
        }
      } catch (e: any) {
        storageOk = false;
        storageError = e?.message ?? 'storage_error';
      }
    }

    return {
      status: dbOk && storageOk ? 'ok' : 'degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      nodeEnv,
      checks: {
        app: { ok: appOk },
        db: { ok: dbOk, error: dbError },
        storage: { ok: storageOk, bucket, error: storageError },
      },
    };
  }
}
