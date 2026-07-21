import { encrypt, decrypt } from './encryption';

/**
 * PII field-level encryption for Prisma (encryption at rest).
 *
 * Encryption is keyed by FIELD NAME, not by model, and applied wherever those
 * names appear — including inside nested `include`d relations and nested writes.
 * This matters because these fields are read pervasively via nested includes
 * (e.g. `payment` → `enrollment.school.accountNumber`, `child.parent.user
 * .phoneNumber`), which a model-scoped Prisma query extension would NOT decrypt.
 *
 * The scheme is randomized AES-256-GCM (see `encryption.ts`), so:
 *   - We never encrypt values inside `where` / `connect` filters — a randomized
 *     ciphertext can't be matched by equality, and doing so would silently break
 *     look-ups. (Equality search on these fields is therefore unsupported.)
 *   - Decryption is best-effort: a value that isn't our ciphertext (e.g. data
 *     written before encryption was enabled) fails the GCM auth check and is
 *     returned unchanged, so the app keeps working through the transition.
 */
export const PII_FIELDS: ReadonlySet<string> = new Set([
  'phoneNumber', // User + Parent
  'phone', // School
  'bankName', // School
  'accountName', // School
  'accountNumber', // School
]);

const WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
]);

export function isWriteOperation(operation: string): boolean {
  return WRITE_OPERATIONS.has(operation);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** Encrypt PII scalars inside a create/update `data` payload, recursing into
 * nested relation writes. Mutates in place. */
function encryptWriteData(data: unknown): void {
  if (Array.isArray(data)) {
    data.forEach(encryptWriteData);
    return;
  }
  if (!isPlainObject(data)) return;

  for (const [key, value] of Object.entries(data)) {
    if (PII_FIELDS.has(key)) {
      if (typeof value === 'string' && value.length > 0) {
        data[key] = encrypt(value);
      } else if (
        isPlainObject(value) &&
        typeof value.set === 'string' &&
        value.set.length > 0
      ) {
        // `{ set: '...' }` scalar-update form
        value.set = encrypt(value.set);
      }
    } else if (value && typeof value === 'object') {
      encryptRelationWrite(value);
    }
  }
}

/** Recurse ONLY into relation-write payloads (create/update/upsert/…). Never
 * touches where / connect / disconnect / delete / select. */
function encryptRelationWrite(relation: unknown): void {
  if (Array.isArray(relation)) {
    relation.forEach(encryptRelationWrite);
    return;
  }
  if (!isPlainObject(relation)) return;

  if (relation.create) encryptWriteData(relation.create);

  if (isPlainObject(relation.update)) {
    encryptWriteData(
      'data' in relation.update ? relation.update.data : relation.update,
    );
  }

  if (relation.upsert) {
    const items = Array.isArray(relation.upsert)
      ? relation.upsert
      : [relation.upsert];
    for (const item of items) {
      if (isPlainObject(item)) {
        if (item.create) encryptWriteData(item.create);
        if (item.update) encryptWriteData(item.update);
      }
    }
  }

  if (relation.connectOrCreate) {
    const items = Array.isArray(relation.connectOrCreate)
      ? relation.connectOrCreate
      : [relation.connectOrCreate];
    for (const item of items) {
      if (isPlainObject(item) && item.create) encryptWriteData(item.create);
    }
  }

  if (isPlainObject(relation.createMany) && relation.createMany.data) {
    encryptWriteData(relation.createMany.data);
  }

  if (relation.updateMany) {
    const items = Array.isArray(relation.updateMany)
      ? relation.updateMany
      : [relation.updateMany];
    for (const item of items) {
      if (isPlainObject(item) && item.data) encryptWriteData(item.data);
    }
  }
}

/** Encrypt PII in the write payload(s) of a Prisma operation's args, in place. */
export function encryptPiiInArgs(operation: string, args: unknown): void {
  if (!isWriteOperation(operation) || !isPlainObject(args)) return;

  if (operation === 'upsert') {
    if (args.create) encryptWriteData(args.create);
    if (args.update) encryptWriteData(args.update);
    return;
  }

  if (args.data !== undefined) encryptWriteData(args.data);
}

function tryDecrypt(value: string): string {
  try {
    return decrypt(value);
  } catch {
    // Not our ciphertext (plaintext from before encryption, or a coincidental
    // field name on another model). Leave it untouched.
    return value;
  }
}

function walkDecrypt(node: unknown, depth: number): void {
  if (node === null || typeof node !== 'object' || depth > 12) return;

  if (Array.isArray(node)) {
    for (const item of node) walkDecrypt(item, depth + 1);
    return;
  }
  if (!isPlainObject(node)) return; // skip Date / Decimal / Buffer instances

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (PII_FIELDS.has(key) && typeof value === 'string' && value.length > 0) {
      node[key] = tryDecrypt(value);
    } else if (value && typeof value === 'object') {
      walkDecrypt(value, depth + 1);
    }
  }
}

/** Decrypt every PII string field in a query result, including nested relations.
 * Mutates in place and returns the same reference. */
export function decryptPiiDeep<T>(node: T): T {
  walkDecrypt(node, 0);
  return node;
}
