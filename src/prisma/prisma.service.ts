import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService) {
    const connectionString = config.get<string>('DATABASE_URL');
    const nodeEnv = config.get<string>('NODE_ENV') ?? 'development';
    const pool = new Pool({
      connectionString,
      ...(nodeEnv === 'production'
        ? {
            ssl: {
              rejectUnauthorized: false,
            },
          }
        : {}),
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Run `fn` only if this instance can claim the named scheduler lock — i.e. the
   * lock row is absent or its previous claim is older than `ttlMs`. Ensures a
   * scheduled job executes on a single instance when horizontally scaled. The
   * claim auto-expires after `ttlMs` (no explicit release needed).
   */
  async withLeaderLock(
    name: string,
    ttlMs: number,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    const cutoff = new Date(Date.now() - ttlMs);
    // Insert the lock, or steal it only if the existing claim is stale.
    // Returns 1 only when this instance acquired it.
    const acquired = await this.$executeRaw`
      INSERT INTO "SchedulerLock" ("name", "lockedAt")
      VALUES (${name}, now())
      ON CONFLICT ("name") DO UPDATE SET "lockedAt" = now()
      WHERE "SchedulerLock"."lockedAt" < ${cutoff}`;
    if (acquired !== 1) return false;
    await fn();
    return true;
  }

  /**
   * Returns a Prisma client scoped to a single school tenant.
   * Automatically injects `schoolId` into every multi-row read/mutation on
   * Payment, ChildEnrollment, and ClassFee so a forgotten where-clause cannot
   * expose cross-tenant data.
   *
   * Use this for all school-owner-facing service methods:
   *   const db = this.prisma.withTenant(schoolId);
   *   await db.payment.findMany({ where: { isConfirmed: false } });
   *   // schoolId is injected automatically — no need to add it manually
   *
   * Note: does NOT apply inside $transaction callbacks (tx is a raw
   * TransactionClient). Single-record mutations (update/delete by PK) also
   * bypass the filter intentionally — they are already scoped by the record's
   * own schoolId field.
   */
  withTenant(schoolId: string) {
    const filter = { schoolId } as const;
    return this.$extends({
      query: {
        payment: {
          findMany:   ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
          findFirst:  ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
          count:      ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
          updateMany: ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
          deleteMany: ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
        },
        childEnrollment: {
          findMany:   ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
          findFirst:  ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
          count:      ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
          updateMany: ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
          deleteMany: ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
        },
        classFee: {
          findMany:   ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
          findFirst:  ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
          count:      ({ args, query }) => query({ ...args, where: { ...args.where, ...filter } }),
        },
      },
    });
  }
}
