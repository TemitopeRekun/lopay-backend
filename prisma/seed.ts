import { PrismaClient, UserRole } from '../src/generated/prisma/client';
import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAuth } from '../src/auth/auth.config';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const auth = createAuth(prisma as unknown as PrismaClient);

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@lopay.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin12345';

  console.log(`🌱 Seeding Super Admin...`);
  console.log(`   Email: ${adminEmail}`);

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existing) {
    // Ensure the role is correct; password is managed by Better Auth.
    await prisma.user.update({
      where: { id: existing.id },
      data: { role: UserRole.SUPER_ADMIN },
    });
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
