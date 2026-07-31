import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** Fixed salt for HKDF. A salt is not a secret; a constant is fine here because
 * the `info` label is what separates one purpose's subkey from another's. */
const HKDF_SALT = 'lopay/hkdf/v1';

let _key: Buffer | null = null;

export function initEncryptionKey(hexKey: string | undefined): void {
  if (!hexKey || hexKey.length < 64) {
    _key = null;
    return;
  }
  _key = Buffer.from(hexKey, 'hex');
}

function deriveKey(): Buffer {
  if (!_key) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
        "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return _key;
}

export function isEncryptionEnabled(): boolean {
  return _key !== null;
}

/**
 * HKDF-derive a purpose-scoped subkey from the master `ENCRYPTION_KEY`, so a
 * feature that needs a key (e.g. the phone blind index) never handles the master
 * key itself and can't collide with another feature's key material.
 *
 * Returns `null` when no master key is configured (dev/test), letting the caller
 * choose its own fallback — production requires `ENCRYPTION_KEY` (see the Joi
 * schema in app.module.ts), so `null` cannot happen there.
 *
 * `label` MUST be versioned (`'…/v1'`): changing it changes every derived value,
 * which for a blind index means a full re-backfill.
 */
export function deriveSubkey(label: string, length = 32): Buffer | null {
  if (!_key) return null;
  return Buffer.from(hkdfSync('sha256', _key, HKDF_SALT, label, length));
}

export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  const key = deriveKey();
  const buf = Buffer.from(ciphertext, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('Invalid ciphertext: too short');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(buf.length - AUTH_TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH, buf.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    'utf8',
  );
}
