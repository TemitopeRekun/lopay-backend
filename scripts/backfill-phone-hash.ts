/**
 * Backfill `User.phoneHash` for accounts that predate the blind-index column,
 * and re-key it after an `ENCRYPTION_KEY` rotation.
 *
 * Why a script and not SQL: `phoneNumber` is encrypted with randomized AES-GCM,
 * so the plaintext only exists after the application layer decrypts it. Postgres
 * cannot compute the HMAC itself.
 *
 * Until this runs, rows with `phoneHash = NULL` are exempt from the unique
 * constraint (Postgres allows unlimited NULLs under a unique index), so two
 * legacy accounts can still share a number. This closes that gap.
 *
 * Usage:
 *   npx ts-node scripts/backfill-phone-hash.ts            # report only
 *   npx ts-node scripts/backfill-phone-hash.ts --apply    # write
 *
 * Safe to re-run: it only writes rows whose stored hash differs from the computed
 * one. Duplicates are REPORTED, never resolved — deciding which of two parents
 * keeps a shared number is a support decision, not a migration's.
 */
import { PrismaClient } from '../src/generated/prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  initEncryptionKey,
  isEncryptionEnabled,
} from '../src/common/encryption';
import { decryptPiiDeep } from '../src/common/pii-crypto';
import { canonicalizePhone, phoneBlindIndex } from '../src/common/phone';

interface Row {
  id: string;
  email: string;
  phoneNumber: string | null;
  phoneHash: string | null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  initEncryptionKey(process.env.ENCRYPTION_KEY);
  if (!isEncryptionEnabled()) {
    console.warn(
      'ENCRYPTION_KEY is not set — assuming plaintext phone numbers and the ' +
        'development fallback blind-index key. Correct for a local database; ' +
        'WRONG against production data.',
    );
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    // Read raw (no PII extension on this client), then decrypt explicitly, so the
    // script works whether or not the rows were written with encryption enabled.
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT "id", "email", "phoneNumber", "phoneHash"
      FROM "User"
      WHERE "phoneNumber" IS NOT NULL AND "deletedAt" IS NULL`;

    const seen = new Map<string, string[]>();
    const updates: Array<{ id: string; phoneHash: string }> = [];
    let unparseable = 0;
    let alreadyCorrect = 0;

    for (const row of rows) {
      const { phoneNumber } = decryptPiiDeep({
        phoneNumber: row.phoneNumber,
      });
      if (!phoneNumber) continue;

      const canonical = canonicalizePhone(phoneNumber);
      if (!canonical) {
        unparseable += 1;
        console.warn(
          `  ! ${row.email}: stored number is not a valid Nigerian number — skipped`,
        );
        continue;
      }

      const phoneHash = phoneBlindIndex(canonical);
      if (!phoneHash) continue;

      seen.set(phoneHash, [...(seen.get(phoneHash) ?? []), row.email]);

      if (row.phoneHash === phoneHash) {
        alreadyCorrect += 1;
        continue;
      }
      updates.push({ id: row.id, phoneHash });
    }

    const duplicates = [...seen.entries()].filter(([, ids]) => ids.length > 1);

    console.log(`\nScanned ${rows.length} account(s) with a phone number.`);
    console.log(`  already correct : ${alreadyCorrect}`);
    console.log(`  to write        : ${updates.length}`);
    console.log(`  unparseable     : ${unparseable}`);
    console.log(`  duplicate sets  : ${duplicates.length}`);

    if (duplicates.length > 0) {
      console.error(
        '\nDuplicate phone numbers found. The unique index cannot accept these; ' +
          'resolve them (contact the parents, clear the wrong one) and re-run:',
      );
      for (const [, emails] of duplicates) {
        console.error(`  - shared by: ${emails.join(', ')}`);
      }
      // Writing partial results would leave the DB half-backfilled with no record
      // of which half. Refuse until the conflict is settled.
      process.exitCode = 1;
      return;
    }

    if (!apply) {
      console.log('\nDry run — pass --apply to write these hashes.');
      return;
    }

    for (const update of updates) {
      await prisma.user.update({
        where: { id: update.id },
        data: { phoneHash: update.phoneHash },
      });
    }
    console.log(`\nWrote ${updates.length} hash(es).`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
