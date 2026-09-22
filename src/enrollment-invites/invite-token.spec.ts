import { createHash } from 'crypto';
import {
  INVITE_TOKEN_LENGTH,
  hashInviteToken,
  mintInviteToken,
} from './invite-token';

/**
 * The token is the only thing standing between a stranger and another family's
 * fee record, so these assert the properties that make it worth anything:
 * unpredictability, a stored form that cannot be replayed, and a recogniser that
 * refuses everything it did not mint.
 */
describe('invite token', () => {
  describe('mintInviteToken', () => {
    it('mints a base64url token of the documented length', () => {
      const { token } = mintInviteToken();
      expect(token).toHaveLength(INVITE_TOKEN_LENGTH);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('never emits base64 padding or the non-url alphabet', () => {
      // '+' and '/' would be re-encoded in a URL and '=' truncated by some
      // clients, so a token containing them would arrive different from how it
      // left. base64url exists to avoid exactly that; this pins it.
      for (let i = 0; i < 200; i += 1) {
        expect(mintInviteToken().token).not.toMatch(/[+/=]/);
      }
    });

    it('does not repeat across many mints', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 1_000; i += 1) seen.add(mintInviteToken().token);
      expect(seen.size).toBe(1_000);
    });

    it('stores a digest, never the token itself', () => {
      const { token, tokenHash } = mintInviteToken();
      expect(tokenHash).not.toContain(token);
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // A leaked database row must not be replayable into a claim: the only way
      // back to the token is to invert SHA-256.
      expect(tokenHash).toBe(
        createHash('sha256').update(token, 'utf8').digest('hex'),
      );
    });
  });

  describe('hashInviteToken', () => {
    it('recognises a token it minted', () => {
      const { token, tokenHash } = mintInviteToken();
      expect(hashInviteToken(token)).toBe(tokenHash);
    });

    it('is deterministic, so the lookup can be a single indexed equality', () => {
      const { token } = mintInviteToken();
      expect(hashInviteToken(token)).toBe(hashInviteToken(token));
    });

    it.each([
      ['empty', ''],
      ['whitespace', '   '],
      ['too short', 'a'.repeat(INVITE_TOKEN_LENGTH - 1)],
      ['too long', 'a'.repeat(INVITE_TOKEN_LENGTH + 1)],
      ['base64 padding', `${'a'.repeat(INVITE_TOKEN_LENGTH - 1)}=`],
      ['non-url base64', `${'a'.repeat(INVITE_TOKEN_LENGTH - 1)}+`],
      ['sql-ish probe', `' OR 1=1 --${'a'.repeat(INVITE_TOKEN_LENGTH)}`],
      ['leading newline', `\n${'a'.repeat(INVITE_TOKEN_LENGTH - 1)}`],
    ])('rejects %s without hashing it', (_label, candidate) => {
      expect(hashInviteToken(candidate)).toBeNull();
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 12345],
      ['an object', { token: 'x' }],
      ['an array', ['a']],
    ])('rejects %s rather than coercing it', (_label, candidate) => {
      // The preview route reads straight from a header, so a client can send
      // anything at all. Coercing would turn `[object Object]` into a lookup.
      expect(hashInviteToken(candidate)).toBeNull();
    });

    it('does not match a token that differs in one character', () => {
      const { token, tokenHash } = mintInviteToken();
      const flipped = `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`;
      expect(hashInviteToken(flipped)).not.toBe(tokenHash);
    });

    it('is case-sensitive', () => {
      const { token, tokenHash } = mintInviteToken();
      const swapped = token
        .split('')
        .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
        .join('');
      if (swapped === token) return; // vanishingly unlikely, but not impossible
      expect(hashInviteToken(swapped)).not.toBe(tokenHash);
    });
  });
});
