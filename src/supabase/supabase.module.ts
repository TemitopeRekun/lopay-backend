import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_CLIENT = 'SUPABASE_CLIENT';

/**
 * Provides a server-side Supabase client (service-role) used for receipt
 * storage — issuing signed upload/download URLs.
 *
 * Optional by design: when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset the
 * provider resolves to `null` so the app still boots. Storage-dependent features
 * then fail with a clear "not configured" error and /health reports storage as
 * degraded (the service stays up).
 */
@Global()
@Module({
  providers: [
    {
      provide: SUPABASE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SupabaseClient | null => {
        const url = config.get<string>('SUPABASE_URL');
        const key = config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
        if (!url || !key) {
          new Logger('SupabaseModule').warn(
            'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — receipt storage ' +
              'is disabled (health will report storage as degraded).',
          );
          return null;
        }
        // Server-to-server: no session persistence or token refresh.
        return createClient(url, key, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
      },
    },
  ],
  exports: [SUPABASE_CLIENT],
})
export class SupabaseModule {}
