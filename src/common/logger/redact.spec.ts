import { fingerprint, maskEmail, maskPhone, redactFields } from './redact';

describe('redact', () => {
  describe('maskEmail', () => {
    it('keeps the domain and the first/last local characters', () => {
      expect(maskEmail('ada.lovelace@gmail.com')).toBe('a***e@gmail.com');
    });

    it('fully masks a short local part rather than leaking all of it', () => {
      expect(maskEmail('ab@gmail.com')).toBe('***@gmail.com');
      expect(maskEmail('a@gmail.com')).toBe('***@gmail.com');
    });

    it('never emits the original local part', () => {
      expect(maskEmail('ada.lovelace@gmail.com')).not.toContain('lovelace');
    });

    it('handles a plus-addressed email', () => {
      expect(maskEmail('ada+lopay@gmail.com')).toBe('a***y@gmail.com');
    });

    it('reports absent and malformed input distinctly', () => {
      expect(maskEmail(undefined)).toBe('<none>');
      expect(maskEmail(null)).toBe('<none>');
      expect(maskEmail('')).toBe('<none>');
      expect(maskEmail('not-an-email')).toBe('<malformed>');
      expect(maskEmail('@nolocal.com')).toBe('<malformed>');
    });
  });

  describe('maskPhone', () => {
    it('keeps only the last four digits', () => {
      expect(maskPhone('08012345678')).toBe('***5678');
      expect(maskPhone('+2348012345678')).toBe('***5678');
    });

    it('ignores formatting when picking the last four', () => {
      expect(maskPhone('0801 234-5678')).toBe('***5678');
    });

    it('never emits the leading digits', () => {
      expect(maskPhone('08012345678')).not.toContain('0801');
    });

    it('handles absent and too-short input', () => {
      expect(maskPhone(undefined)).toBe('<none>');
      expect(maskPhone('')).toBe('<none>');
      expect(maskPhone('12')).toBe('***');
    });
  });

  describe('fingerprint', () => {
    it('is stable and short', () => {
      expect(fingerprint('abc')).toBe(fingerprint('abc'));
      expect(fingerprint('abc')).toHaveLength(12);
    });

    it('separates different inputs', () => {
      expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
    });
  });

  describe('redactFields', () => {
    it('replaces secrets wholesale', () => {
      expect(
        redactFields({ password: 'hunter2', token: 'abc.def', secret: 's' }),
      ).toEqual({
        password: '[redacted]',
        token: '[redacted]',
        secret: '[redacted]',
      });
    });

    it('masks contact details instead of dropping them, so a log stays diagnosable', () => {
      expect(
        redactFields({
          email: 'ada.lovelace@gmail.com',
          phoneNumber: '08012345678',
        }),
      ).toEqual({ email: 'a***e@gmail.com', phoneNumber: '***5678' });
    });

    it('passes non-sensitive fields through untouched', () => {
      expect(
        redactFields({ reason: 'PHONE_ALREADY_REGISTERED', attempt: 3 }),
      ).toEqual({ reason: 'PHONE_ALREADY_REGISTERED', attempt: 3 });
    });

    it('leaves a non-string value under a masked key alone rather than crashing', () => {
      expect(redactFields({ email: undefined, phoneNumber: null })).toEqual({
        email: undefined,
        phoneNumber: null,
      });
    });

    it('covers every alias the codebase logs contact details under', () => {
      const out = redactFields({
        ownerEmail: 'owner@school.com',
        phone: '08012345678',
        accountNumber: '0123456789',
      });
      expect(out.ownerEmail).toBe('o***r@school.com');
      expect(out.phone).toBe('***5678');
      expect(out.accountNumber).toBe('[redacted]');
    });
  });
});
