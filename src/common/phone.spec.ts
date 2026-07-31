import {
  canonicalizePhone,
  isValidPhone,
  phoneBlindIndex,
  stripPhoneFormatting,
} from './phone';
import { initEncryptionKey } from './encryption';

const ZWSP = String.fromCharCode(0x200b);
const ZWNJ = String.fromCharCode(0x200c);
const BOM = String.fromCharCode(0xfeff);

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

describe('phone', () => {
  afterEach(() => {
    initEncryptionKey(undefined);
  });

  describe('stripPhoneFormatting', () => {
    it('removes the punctuation people type for legibility', () => {
      expect(stripPhoneFormatting('(0801) 234-5678')).toBe('08012345678');
      expect(stripPhoneFormatting('0801.234.5678')).toBe('08012345678');
    });

    it('removes zero-width and control characters', () => {
      expect(stripPhoneFormatting(`0801${ZWSP}234${ZWNJ}5678${BOM}`)).toBe(
        '08012345678',
      );
      expect(stripPhoneFormatting('08012345678')).toBe('08012345678');
    });

    // Regression: the invisible-character class is built from codepoints because
    // an earlier `\p{C}` inside a template literal collapsed to a literal `p`,
    // which silently stripped the letter p from every input.
    it('does not strip ordinary letters', () => {
      expect(stripPhoneFormatting('p0801')).toBe('p0801');
      expect(stripPhoneFormatting('CpP')).toBe('CpP');
    });
  });

  describe('canonicalizePhone', () => {
    it.each([
      ['08012345678', '+2348012345678'],
      ['0801 234 5678', '+2348012345678'],
      ['0801-234-5678', '+2348012345678'],
      ['+2348012345678', '+2348012345678'],
      ['2348012345678', '+2348012345678'],
      ['+234 801 234 5678', '+2348012345678'],
      ['(0801)234.5678', '+2348012345678'],
    ])('folds %s to %s', (input, expected) => {
      expect(canonicalizePhone(input)).toBe(expected);
    });

    it.each([
      ['', 'empty'],
      ['801234567', 'too short, no prefix'],
      ['0801234567', 'ten digits after the 0'],
      ['080123456789', 'twelve digits after the 0'],
      ['+2358012345678', 'wrong country code'],
      ['not-a-number', 'letters'],
      ['0801234567a', 'trailing letter'],
    ])('rejects %s (%s)', (input) => {
      expect(canonicalizePhone(input)).toBeNull();
    });

    it('is the property the uniqueness check depends on: every accepted spelling of one number folds to one string', () => {
      const spellings = [
        '08012345678',
        '0801 234 5678',
        '+2348012345678',
        '234 801 234 5678',
        '(0801)-234.5678',
      ];
      const canonical = new Set(spellings.map(canonicalizePhone));
      expect(canonical.size).toBe(1);
    });
  });

  describe('isValidPhone', () => {
    it('accepts the plain 11-digit local form', () => {
      expect(isValidPhone('08012345678')).toBe(true);
    });

    it('still accepts a +234 number even though the copy asks for the local form', () => {
      expect(isValidPhone('+234 801 234 5678')).toBe(true);
    });

    it('rejects a short number', () => {
      expect(isValidPhone('801234567')).toBe(false);
    });
  });

  describe('phoneBlindIndex', () => {
    it('is deterministic for the same number and key', () => {
      initEncryptionKey(KEY_A);
      expect(phoneBlindIndex('08012345678')).toBe(
        phoneBlindIndex('08012345678'),
      );
    });

    it('collapses every spelling of one number to one hash — this is what makes duplicate detection work', () => {
      initEncryptionKey(KEY_A);
      const hashes = new Set([
        phoneBlindIndex('08012345678'),
        phoneBlindIndex('0801 234-5678'),
        phoneBlindIndex('+2348012345678'),
        phoneBlindIndex('2348012345678'),
      ]);
      expect(hashes.size).toBe(1);
    });

    it('separates different numbers', () => {
      initEncryptionKey(KEY_A);
      expect(phoneBlindIndex('08012345678')).not.toBe(
        phoneBlindIndex('08012345679'),
      );
    });

    it('returns null rather than hashing an invalid number', () => {
      initEncryptionKey(KEY_A);
      expect(phoneBlindIndex('nope')).toBeNull();
      expect(phoneBlindIndex('')).toBeNull();
      expect(phoneBlindIndex('0801234567')).toBeNull();
    });

    it('produces a hex sha256 digest, not the number itself', () => {
      initEncryptionKey(KEY_A);
      const hash = phoneBlindIndex('08012345678');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toContain('8012345678');
    });

    // The security property: a stolen database is useless without the key,
    // because the ten-digit search space is otherwise trivially exhaustible.
    it('changes completely when the master key changes', () => {
      initEncryptionKey(KEY_A);
      const withA = phoneBlindIndex('08012345678');
      initEncryptionKey(KEY_B);
      const withB = phoneBlindIndex('08012345678');
      expect(withA).not.toBe(withB);
    });

    it('still works with no master key, using the documented dev fallback', () => {
      initEncryptionKey(undefined);
      expect(phoneBlindIndex('08012345678')).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
