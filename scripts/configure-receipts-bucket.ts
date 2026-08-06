/**
 * Enforce size and MIME limits on the receipts storage bucket.
 *
 * Why a script and not application code: receipts never pass through this API.
 * `DocumentsService.createReceiptUploadUrl` mints a Supabase signed upload URL
 * and the browser PUTs the file straight to storage, so the server validates
 * the *request for a URL* and never sees the bytes. The bucket's own
 * `file_size_limit` and `allowed_mime_types` are therefore the ONLY thing
 * standing between an authenticated parent and writing an object of any size
 * and any type into the bucket. Until this runs, both are NULL — unlimited.
 *
 * `public` is asserted, never changed. Receipts show payer bank details, and
 * flipping a bucket's visibility is not a decision a config script should make
 * on its own — it reports and exits non-zero instead.
 *
 * The MIME list is kept identical to ALLOWED_RECEIPT_CONTENT_TYPES in
 * documents.service.ts. Those two drifting apart is the failure mode this
 * script's DIFF output exists to make obvious.
 *
 * Usage:
 *   npx ts-node scripts/configure-receipts-bucket.ts            # report only
 *   npx ts-node scripts/configure-receipts-bucket.ts --apply    # write
 *
 * Safe to re-run: it writes only when the live config differs from the target,
 * and affects new uploads only — existing objects are untouched.
 */
import { createClient } from '@supabase/supabase-js';

/** Must match ALLOWED_RECEIPT_CONTENT_TYPES in src/documents/documents.service.ts. */
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];

/** Matches DEFAULT_MAX_UPLOAD_BYTES, which the API reports to clients. */
const FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

function equalSets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucketName = process.env.SUPABASE_STORAGE_BUCKET ?? 'receipts';

  if (!url || !serviceKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (the service-role key is required to change bucket config).',
    );
  }

  const supabase = createClient(url, serviceKey);

  const { data: bucket, error: readError } =
    await supabase.storage.getBucket(bucketName);
  if (readError || !bucket) {
    throw new Error(
      `Could not read bucket "${bucketName}": ${readError?.message ?? 'not found'}`,
    );
  }

  const liveMime = bucket.allowed_mime_types ?? [];
  const liveSize = bucket.file_size_limit ?? null;

  console.log(`Bucket "${bucketName}" (${url})`);
  console.log(`  public            : ${bucket.public}`);
  console.log(`  file_size_limit   : ${liveSize ?? 'NULL (unlimited)'}`);
  console.log(
    `  allowed_mime_types: ${liveMime.length ? liveMime.join(', ') : 'NULL (any type)'}`,
  );

  // A public receipts bucket leaks payer bank details to anyone with a URL.
  // Report loudly and stop; do not silently "fix" a visibility change.
  if (bucket.public) {
    console.error(
      `\nREFUSING TO CONTINUE: bucket "${bucketName}" is PUBLIC. Receipts contain ` +
        `payer bank details. Make it private in the Supabase dashboard ` +
        `(Storage -> ${bucketName} -> Settings), then re-run.`,
    );
    process.exitCode = 1;
    return;
  }

  const sizeOk = liveSize === FILE_SIZE_LIMIT_BYTES;
  const mimeOk = equalSets(liveMime, ALLOWED_MIME_TYPES);

  if (sizeOk && mimeOk) {
    console.log('\nAlready configured — nothing to do.');
    return;
  }

  console.log('\nDIFF');
  if (!sizeOk) {
    console.log(
      `  file_size_limit   : ${liveSize ?? 'NULL'} -> ${FILE_SIZE_LIMIT_BYTES}`,
    );
  }
  if (!mimeOk) {
    console.log(
      `  allowed_mime_types: ${liveMime.length ? liveMime.join(', ') : 'NULL'} -> ${ALLOWED_MIME_TYPES.join(', ')}`,
    );
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write these changes.');
    return;
  }

  const { error: updateError } = await supabase.storage.updateBucket(
    bucketName,
    {
      public: false,
      fileSizeLimit: FILE_SIZE_LIMIT_BYTES,
      allowedMimeTypes: ALLOWED_MIME_TYPES,
    },
  );
  if (updateError) {
    throw new Error(`Failed to update bucket: ${updateError.message}`);
  }

  // Read back rather than trusting the write: this is the assertion the health
  // check will make on every deploy, so prove it here too.
  const { data: after } = await supabase.storage.getBucket(bucketName);
  console.log('\nApplied. Now:');
  console.log(`  file_size_limit   : ${after?.file_size_limit}`);
  console.log(
    `  allowed_mime_types: ${(after?.allowed_mime_types ?? []).join(', ')}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
