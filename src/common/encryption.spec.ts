import {
  initEncryptionKey,
  isEncryptionEnabled,
  encrypt,
  decrypt,
} from './encryption';

const VALID_KEY = 'a'.repeat(64); // 32 bytes of hex

describe('encryption', () => {
  afterEach(() => {
    // Reset module state so tests don't leak the key into each other.
    initEncryptionKey(undefined);
  });

  describe('initEncryptionKey / isEncryptionEnabled', () => {
    it('is disabled when no key is provided', () => {
      initEncryptionKey(undefined);
      expect(isEncryptionEnabled()).toBe(false);
    });

    it('is disabled when the key is shorter than 64 chars', () => {
      initEncryptionKey('abc');
      expect(isEncryptionEnabled()).toBe(false);
    });

    it('is enabled with a valid 64-char hex key', () => {
      initEncryptionKey(VALID_KEY);
      expect(isEncryptionEnabled()).toBe(true);
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trips plaintext back to the original', () => {
      initEncryptionKey(VALID_KEY);
      const plaintext = '+2348012345678';
      const ciphertext = encrypt(plaintext);
      expect(ciphertext).not.toEqual(plaintext);
      expect(decrypt(ciphertext)).toEqual(plaintext);
    });

    it('produces a different ciphertext each time (random IV)', () => {
      initEncryptionKey(VALID_KEY);
      expect(encrypt('same')).not.toEqual(encrypt('same'));
    });

    it('throws when encrypting without a configured key', () => {
      initEncryptionKey(undefined);
      expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY/);
    });

    it('throws when decrypting without a configured key', () => {
      initEncryptionKey(undefined);
      expect(() => decrypt('AAAA')).toThrow(/ENCRYPTION_KEY/);
    });

    it('rejects ciphertext that is too short', () => {
      initEncryptionKey(VALID_KEY);
      const tooShort = Buffer.from('short').toString('base64');
      expect(() => decrypt(tooShort)).toThrow(/too short/);
    });

    it('fails authentication when the ciphertext is tampered with', () => {
      initEncryptionKey(VALID_KEY);
      const ciphertext = encrypt('sensitive');
      const raw = Buffer.from(ciphertext, 'base64');
      raw[raw.length - 1] ^= 0xff; // flip a bit in the auth tag
      const tampered = raw.toString('base64');
      expect(() => decrypt(tampered)).toThrow();
    });
  });
});
