import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';

/**
 * Global cache (Milestone 4). Depends on the shared Redis client provided by the
 * global RedisModule; exported so feature services can inject CacheService
 * without importing this module explicitly.
 */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
