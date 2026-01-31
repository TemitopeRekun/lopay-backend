import { PrismaClient, UserRole } from '../src/generated/prisma/client';
import * as admin from 'firebase-admin';
import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@lopay.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123'; // Default password

  console.log(`🌱 Seeding Super Admin...`);
  console.log(`   Email: ${adminEmail}`);

  // 1. Initialize Firebase
  if (admin.apps.length === 0) {
    if (
      !process.env.FIREBASE_PROJECT_ID ||
      !process.env.FIREBASE_CLIENT_EMAIL ||
      !process.env.FIREBASE_PRIVATE_KEY
    ) {
      throw new Error('Missing Firebase Configuration in .env');
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    console.log('   ✅ Firebase initialized.');
  }

  let firebaseUser;

  // 2. Create or Get Firebase User
  try {
    firebaseUser = await admin.auth().getUserByEmail(adminEmail);
    console.log('   ✅ Firebase user already exists.');
    // Ensure password matches the current environment variable
    await admin
      .auth()
      .updateUser(firebaseUser.uid, { password: adminPassword });
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      console.log('   ✨ Creating new Firebase user...');
      firebaseUser = await admin.auth().createUser({
        email: adminEmail,
        password: adminPassword,
        displayName: 'Super Admin',
      });
      console.log('   ✅ Firebase user created.');
    } else {
      console.error('   ❌ Firebase Error:', error);
      throw error;
    }
  }

  // 3. Create or Update DB User
  const user = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      role: UserRole.SUPER_ADMIN, // Ensure role is always SUPER_ADMIN
    },
    create: {
      id: firebaseUser.uid, // Sync UID
      email: adminEmail,
      password: 'firebase-auth-user', // Placeholder
      role: UserRole.SUPER_ADMIN,
    },
  });

  console.log(`   ✅ Super Admin synced to Database (ID: ${user.id})`);
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
