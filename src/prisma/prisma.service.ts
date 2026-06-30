import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolConfig } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private static readonly bootLogger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const connectionString = config.get<string>('DATABASE_URL');
    const nodeEnv = config.get<string>('NODE_ENV') ?? 'development';
    const pool = new Pool({
      connectionString,
      // Cap connections per instance so N app instances stay within Postgres'
      // max_connections (Scale, M4). Default 10; size via DATABASE_POOL_MAX. When
      // fronted by PgBouncer (transaction pooling), set this to a small number and
      // add `?pgbouncer=true&connection_limit=1` to DATABASE_URL — see the runbook.
      ...PrismaService.buildPoolSizing(config),
      ...PrismaService.buildSslConfig(nodeEnv, config),
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
  }

  /** Per-instance pg pool ceiling. `max` bounds concurrent DB connections so a
   * horizontally-scaled deployment can't exhaust Postgres' connection slots. */
  private static buildPoolSizing(
    config: ConfigService,
  ): Pick<PoolConfig, 'max'> {
    const raw = config.get<string>('DATABASE_POOL_MAX');
    const parsed = raw === undefined ? NaN : Number(raw);
    const max = Number.isInteger(parsed) && parsed > 0 ? parsed : 10;
    return { max };
  }

  /**
   * TLS for the production DB connection.
   *
   * When `DATABASE_CA_CERT` (PEM contents) is provided we pin it and enforce
   * `rejectUnauthorized: true` — the connection is verified against that CA and
   * MITM is rejected. If no CA is configured we fall back to the previous
   * permissive behaviour (`rejectUnauthorized: false`) so existing deploys keep
   * connecting, but log a warning so the gap is visible and gets closed. Non-prod
   * connects without TLS (local Postgres).
   */
  private static buildSslConfig(
    nodeEnv: string,
    config: ConfigService,
  ): Pick<PoolConfig, 'ssl'> {
    if (nodeEnv !== 'production') return {};
    const ca = config.get<string>('DATABASE_CA_CERT');
    if (ca && ca.trim()) {
      return { ssl: { ca, rejectUnauthorized: true } };
    }
    PrismaService.bootLogger.warn(
      'DATABASE_CA_CERT is not set — connecting with rejectUnauthorized:false ' +
        '(no CA pinning). Set DATABASE_CA_CERT to the DB CA PEM to verify the ' +
        'server certificate and close this MITM gap.',
    );
    return { ssl: { rejectUnauthorized: false } };
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
   * Scope policy (Milestone 3 — "adopt everywhere or remove": kept, applied by
   * access pattern). `withTenant` guards the **school-owner tenant** surface,
   * where a request is bounded to one school the caller owns:
   *   - DO use it: `SchoolPaymentsService` reads and the school-owner ledger
   *     transitions (`LedgerService.confirm/reject/reverse/markEnrollmentAsDefaulted`).
   *   - DON'T use it for SUPER_ADMIN flows (`AdminService`) — admins operate
   *     across all schools, so a single-tenant filter would be wrong; those
   *     queries are cross-school by design (or pass an explicit `schoolId`).
   *   - DON'T use it for parent/Paystack flows (`EnrollmentService`) — those
   *     are keyed by enrollmentId / paystackReference / (schoolId, className)
   *     and are already scoped by that key, not by an owner's tenant.
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
          findMany: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
          findFirst: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
          count: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
          updateMany: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
          deleteMany: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
        },
        childEnrollment: {
          findMany: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
          findFirst: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
          count: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
          updateMany: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
          deleteMany: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
        },
        classFee: {
          findMany: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
          findFirst: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
          count: ({ args, query }) =>
            query({ ...args, where: { ...args.where, ...filter } }),
        },
      },
    });
  }
}
