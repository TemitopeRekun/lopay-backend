import { PrismaClient, UserRole } from '../src/generated/prisma/client';
import * as dotenv from 'dotenv';
import { Pool, PoolConfig } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAuth } from '../src/auth/auth.config';

dotenv.config();

/**
 * Mirror PrismaService.buildSslConfig so the seed can reach a managed DB
 * (Supabase/Neon) exactly like the app does. `sslmode` is stripped from the URL
 * whenever we supply an explicit `ssl` object: recent pg versions treat the
 * connection-string `sslmode=require` as `verify-full`, which overrides the
 * pool's `ssl` option and fails against a managed provider's chain with
 * "self-signed certificate in certificate chain".
 */
function buildPoolConfig(): PoolConfig {
  const url = process.env.DATABASE_URL ?? '';
  const stripped = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const sslMode = (process.env.DATABASE_SSL ?? '').toLowerCase();
  const urlSslMode = /[?&]sslmode=([^&]+)/.exec(url)?.[1]?.toLowerCase() ?? '';

  if (['disable', 'false', 'off'].includes(sslMode)) {
    return { connectionString: stripped };
  }
  const sslOn =
    process.env.NODE_ENV === 'production' ||
    ['require', 'true', 'on'].includes(sslMode) ||
    ['require', 'prefer', 'verify-ca', 'verify-full'].includes(urlSslMode);
  if (!sslOn) {
    return { connectionString: url };
  }
  const ca = process.env.DATABASE_CA_CERT;
  return {
    connectionString: stripped,
    ssl: ca && ca.trim() ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
  };
}

const pool = new Pool(buildPoolConfig());
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const auth = createAuth(prisma as unknown as PrismaClient);

async function main() {
  // Never seed a guessable default credential in production. Require an explicit
  // strong password there; only fall back to a dev default outside production.
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
    throw new Error(
      'ADMIN_PASSWORD must be set in production before seeding the super admin.',
    );
  }
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@lopay.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin12345';

  console.log(`🌱 Seeding Super Admin...`);
  console.log(`   Email: ${adminEmail}`);

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { role: UserRole.SUPER_ADMIN },
    });

    // Reconcile the password so rotating ADMIN_PASSWORD and re-running the seed
    // actually takes effect (previously this branch returned early, silently
    // leaving the old credential in place). Only when ADMIN_PASSWORD is set
    // explicitly — otherwise a bare re-run would reset a deliberately-changed
    // password back to the dev fallback.
    if (process.env.ADMIN_PASSWORD) {
      const credential = await prisma.account.findFirst({
        where: { userId: existing.id, providerId: 'credential' },
        select: { id: true },
      });
      if (!credential) {
        throw new Error(
          `Super Admin ${adminEmail} has no email/password account (Google-only?). ` +
            'Cannot set ADMIN_PASSWORD; sign in with the social provider instead.',
        );
      }
      const ctx = await auth.$context;
      await ctx.internalAdapter.updatePassword(
        existing.id,
        await ctx.password.hash(adminPassword),
      );
      console.log('   🔑 Password reconciled from ADMIN_PASSWORD.');
    }

    console.log(`   ✅ Super Admin already exists (ID: ${existing.id}); role ensured.`);
    return;
  }

  // Create via Better Auth so a credential account (password hash) is created.
  const res = await auth.api.signUpEmail({
    body: { email: adminEmail, password: adminPassword, name: 'Super Admin' } as any,
  });
  // role is not a sign-up input (security); elevate to SUPER_ADMIN server-side.
  await prisma.user.update({
    where: { id: res.user.id },
    data: { role: UserRole.SUPER_ADMIN },
  });

  console.log(`   ✅ Super Admin created via Better Auth (ID: ${res.user.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
