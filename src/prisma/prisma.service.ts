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
import { isEncryptionEnabled } from '../common/encryption';
import {
  encryptPiiInArgs,
  decryptPiiDeep,
  isWriteOperation,
} from '../common/pii-crypto';

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

    // PII encryption at rest. A Prisma `$extends` client is a NEW object (it does
    // not mutate `this`), so to make the extension apply to the injected service —
    // which the whole app, and Better Auth, call as `prisma.*` — we return a Proxy
    // that routes the client surface through the extended client. When no key is
    // configured this is skipped entirely and behaviour is byte-identical.
    if (isEncryptionEnabled()) {
      return PrismaService.withPiiEncryption(this);
    }
  }

  /** Wrap `base` so every model/query call runs through a PII-encryption
   * `$extends` client, while the service-specific members (lifecycle hooks,
   * `withTenant`, `withLeaderLock`) keep resolving to the base instance. */
  private static withPiiEncryption(base: PrismaService): PrismaService {
    const extended = base.$extends({
      name: 'pii-encryption',
      query: {
        $allModels: {
          $allOperations: async ({ operation, args, query }) => {
            if (isWriteOperation(operation)) {
              encryptPiiInArgs(operation, args);
            }
            const result = (await query(args)) as unknown;
            return decryptPiiDeep(result);
          },
        },
      },
    });

    // Members that live on PrismaService (not on the Prisma client) must resolve
    // to the base; everything else (model delegates, `$transaction`, `$connect`,
    // `$extends` used by `withTenant`, …) resolves to the extended client.
    const ownMembers = new Set<string>([
      'withTenant',
      'withLeaderLock',
      'onModuleInit',
      'onModuleDestroy',
    ]);

    const extendedIndex = extended as unknown as Record<
      string | symbol,
      unknown
    >;

    return new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && ownMembers.has(prop)) {
          const member = Reflect.get(target, prop, target) as unknown;
          return typeof member === 'function'
            ? (member as (...a: unknown[]) => unknown).bind(receiver)
            : member;
        }
        const value = extendedIndex[prop];
        if (value === undefined) {
          const fallback = Reflect.get(target, prop, target) as unknown;
          return typeof fallback === 'function'
            ? (fallback as (...a: unknown[]) => unknown).bind(target)
            : fallback;
        }
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(extended)
          : value;
      },
    }) as unknown as PrismaService;
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
    // TLS decision, in order:
    //   DATABASE_SSL=disable -> never use TLS (same-host/private-network DB, e.g.
    //     a Docker container on an isolated bridge, or a localhost/socket DB).
    //   production           -> TLS on by default.
    //   DATABASE_SSL=require -> TLS on even outside production, for a non-prod app
    //     pointed at a managed DB that needs TLS (e.g. Supabase/Neon in staging).
    //   otherwise (non-prod) -> no TLS (local Postgres).
    const sslMode = (config.get<string>('DATABASE_SSL') ?? '').toLowerCase();
    if (['disable', 'false', 'off'].includes(sslMode)) {
      return {};
    }
    const sslOn =
      nodeEnv === 'production' || ['require', 'true', 'on'].includes(sslMode);
    if (!sslOn) {
      return {};
    }
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
