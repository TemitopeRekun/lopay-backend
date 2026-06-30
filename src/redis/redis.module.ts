import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** DI token for the shared ioredis client (or `null` when REDIS_URL is unset). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Provides ONE shared ioredis connection for every multi-instance feature
 * (distributed rate limiting + cache), gated on `REDIS_URL` (Milestone 4).
 *
 * When `REDIS_URL` is absent the token resolves to `null` and each consumer
 * falls back to its in-process behaviour, so single-instance dev runs unchanged
 * with no Redis dependency. The connection lifecycle is owned here so collaborators
 * (throttler storage, rate-limit store, cache) can borrow the client without each
 * opening — or, worse, closing — its own.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis | null => {
        const url = config.get<string>('REDIS_URL');
        const logger = new Logger('RedisModule');
        if (!url) {
          logger.log(
            'REDIS_URL not set — shared rate limiting and Redis cache are ' +
              'disabled; using in-process fallbacks (fine for single-instance).',
          );
          return null;
        }
        const client = new Redis(url, {
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
        });
        client.on('error', (err: Error) =>
          logger.error(`Redis connection error: ${err.message}`),
        );
        client.on('ready', () => logger.log('Redis connected.'));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis | null) {}

  async onApplicationShutdown() {
    if (this.client) {
      await this.client.quit();
    }
  }
}
