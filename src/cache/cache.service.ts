import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Small JSON cache (Milestone 4). Backed by the shared Redis client when
 * `REDIS_URL` is set (so a value cached on one instance is seen by all), and by
 * a process-local Map with TTL otherwise. The API is identical either way, so
 * callers never branch on whether Redis is configured.
 *
 * Used for short-lived, read-heavy data: per-school class fees, the Paystack bank
 * list, and dashboard aggregates. Keep keys explicit and invalidate the exact key
 * on write (no wildcard scans) so this stays O(1) and cluster-safe.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly memory = new Map<
    string,
    { value: unknown; expiresAt: number }
  >();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  /** Return the cached value if present, else run `loader`, cache it, return it. */
  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await loader();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        return raw === null ? undefined : (JSON.parse(raw) as T);
      } catch (err) {
        // A cache read must never break the request — fall through to a miss.
        this.logger.warn(
          `cache get failed for ${key}: ${(err as Error).message}`,
        );
        return undefined;
      }
    }
    const entry = this.memory.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      } catch (err) {
        this.logger.warn(
          `cache set failed for ${key}: ${(err as Error).message}`,
        );
      }
      return;
    }
    this.memory.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  /** Invalidate an exact key (call on the write that makes it stale). */
  async del(key: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(key);
      } catch (err) {
        this.logger.warn(
          `cache del failed for ${key}: ${(err as Error).message}`,
        );
      }
      return;
    }
    this.memory.delete(key);
  }
}

/** Centralised cache-key builders so producers and invalidators can't drift. */
export const CacheKeys = {
  classFees: (schoolId: string) => `cache:classfees:${schoolId}`,
  paystackBanks: () => 'cache:paystack:banks',
  adminRevenue: () => 'cache:admin:revenue',
  adminStudentsSummary: () => 'cache:admin:students-summary',
  adminSchoolsSummary: () => 'cache:admin:schools-summary',
  adminSchoolsPayoutStatus: () => 'cache:admin:schools-payout-status',
  adminBreakdownSummary: () => 'cache:admin:breakdown-summary',
} as const;
