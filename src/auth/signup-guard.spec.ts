import type { PrismaClient } from '../generated/prisma/client';
import {
  AuthApiError,
  guardUserCreate,
  guardUserUpdate,
  sanitizeName,
  type UserCreateData,
} from './signup-guard';
import { AUTH_ERROR_CODES } from '../common/auth-error-codes';
import { canonicalizePhone, phoneBlindIndex } from '../common/phone';
import { initEncryptionKey } from '../common/encryption';

const ZWSP = String.fromCharCode(0x200b);

/** Prisma double exposing only what the guard touches. */
function makePrisma(existingPhoneHash: string | null = null) {
  const findUnique = jest.fn(
    ({ where }: { where: { phoneHash: string } }) =>
      Promise.resolve(
        existingPhoneHash && where.phoneHash === existingPhoneHash
          ? { id: 'existing-user' }
          : null,
      ) as unknown,
  );
  return {
    prisma: { user: { findUnique } } as unknown as PrismaClient,
    findUnique,
  };
}

/** Read the `code` off a thrown Better Auth APIError. */
function codeOf(error: unknown): string | undefined {
  const body = (error as { body?: { code?: string } }).body;
  return body?.code;
}

async function expectRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toBeDefined();
  await promise.catch((error: unknown) => {
    expect(codeOf(error)).toBe(code);
  });
}

/**
 * The guard declares its own `APIError` stand-in instead of importing the
 * ESM-only `better-auth/api`. That only works because Better Auth identifies its
 * errors by duck type. These tests replicate both `isAPIError` implementations
 * and the fields the response builder reads, so a library upgrade that tightens
 * the check fails HERE — loudly — rather than in production, where the symptom
 * would be every coded rejection silently degrading to a generic 500.
 */
describe('AuthApiError wire compatibility', () => {
  const error = new AuthApiError('UNPROCESSABLE_ENTITY', {
    code: 'PHONE_ALREADY_REGISTERED',
    message: 'taken',
  });

  it('passes the duck-type check both isAPIError implementations use', () => {
    // @better-auth/core: `(error as { name?: string })?.name === 'APIError'`
    // better-call:       `error instanceof APIError || error?.name === 'APIError'`
    expect((error as unknown as { name: string }).name).toBe('APIError');
  });

  it('carries every field the response builder reads off it', () => {
    // toResponse(data.body, { status: data.statusCode, headers: data.headers })
    expect(error.body).toEqual({
      code: 'PHONE_ALREADY_REGISTERED',
      message: 'taken',
    });
    expect(error.statusCode).toBe(422);
    expect(error.headers).toEqual({});
    expect(error.status).toBe('UNPROCESSABLE_ENTITY');
  });

  it('is a real Error, so a stack trace still exists for unexpected throws', () => {
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('taken');
    expect(error.stack).toBeDefined();
  });

  it('maps CONFLICT to 409', () => {
    expect(
      new AuthApiError('CONFLICT', { code: 'X', message: 'y' }).statusCode,
    ).toBe(409);
  });
});

describe('sanitizeName', () => {
  it('trims and collapses whitespace', () => {
    expect(sanitizeName('  Ada   Lovelace \n')).toBe('Ada Lovelace');
  });

  it('strips zero-width characters used to pad or impersonate a name', () => {
    expect(sanitizeName(`Ada${ZWSP}Lovelace`)).toBe('AdaLovelace');
    expect(sanitizeName(`${ZWSP}${ZWSP}`)).toBe('');
  });

  it('deletes non-whitespace control characters', () => {
    const NUL = String.fromCharCode(0x00);
    const BELL = String.fromCharCode(0x07);
    const ESC = String.fromCharCode(0x1b);
    expect(sanitizeName(`Ada${NUL}${BELL}${ESC}Lovelace`)).toBe('AdaLovelace');
  });

  // A name typed across a line break is still two words. Deleting the newline
  // instead of collapsing it would store "AdaLovelace" — a different name.
  it('collapses a smuggled newline to a space rather than deleting it', () => {
    const LF = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const TAB = String.fromCharCode(9);
    expect(sanitizeName(`Ada${LF}Lovelace`)).toBe('Ada Lovelace');
    expect(sanitizeName(`Ada${CR}${LF}Lovelace`)).toBe('Ada Lovelace');
    expect(sanitizeName(`Ada${TAB}Lovelace`)).toBe('Ada Lovelace');
  });

  it('leaves a legitimate name untouched, including accents and hyphens', () => {
    expect(sanitizeName('Chiamaka Obi-Nwosu')).toBe('Chiamaka Obi-Nwosu');
    expect(sanitizeName('Zoë Adébáyò')).toBe('Zoë Adébáyò');
  });

  it('does not escape markup — React escapes on render; escaping here would double-encode', () => {
    expect(sanitizeName('Ada <b> Lovelace')).toBe('Ada <b> Lovelace');
  });
});

describe('guardUserCreate', () => {
  beforeEach(() => {
    initEncryptionKey('a'.repeat(64));
  });
  afterEach(() => {
    initEncryptionKey(undefined);
    jest.restoreAllMocks();
  });

  describe('display name', () => {
    it('writes the sanitized name to both name and the fullName mirror', async () => {
      const { prisma } = makePrisma();
      const data = await guardUserCreate(prisma, {
        name: '  Ada   Lovelace ',
        email: 'ada@gmail.com',
      });

      expect(data.name).toBe('Ada Lovelace');
      expect(data.fullName).toBe('Ada Lovelace');
    });

    it('rejects a name that is blank once sanitized', async () => {
      const { prisma } = makePrisma();
      await expectRejection(
        guardUserCreate(prisma, { name: `  ${ZWSP} `, email: 'a@b.com' }),
        AUTH_ERROR_CODES.NAME_REQUIRED,
      );
    });

    it('rejects a single-character name', async () => {
      const { prisma } = makePrisma();
      await expectRejection(
        guardUserCreate(prisma, { name: 'A', email: 'a@b.com' }),
        AUTH_ERROR_CODES.NAME_LENGTH,
      );
    });

    it('rejects a name past the column bound', async () => {
      const { prisma } = makePrisma();
      await expectRejection(
        guardUserCreate(prisma, { name: 'a'.repeat(81), email: 'a@b.com' }),
        AUTH_ERROR_CODES.NAME_LENGTH,
      );
    });

    it('accepts a name exactly at each boundary', async () => {
      const { prisma } = makePrisma();
      await expect(
        guardUserCreate(prisma, { name: 'Ab', email: 'a@b.com' }),
      ).resolves.toMatchObject({ name: 'Ab' });
      await expect(
        guardUserCreate(prisma, { name: 'a'.repeat(80), email: 'a@b.com' }),
      ).resolves.toMatchObject({ fullName: 'a'.repeat(80) });
    });

    // Google sign-in can arrive with no name at all; rejecting it would break a
    // legitimate social sign-up.
    it('allows a missing name rather than rejecting a social sign-in', async () => {
      const { prisma } = makePrisma();
      await expect(
        guardUserCreate(prisma, { email: 'ada@gmail.com' }),
      ).resolves.toMatchObject({ email: 'ada@gmail.com' });
    });
  });

  describe('phone number', () => {
    it('stores the canonical form and its blind index', async () => {
      const { prisma } = makePrisma();
      const data = await guardUserCreate(prisma, {
        name: 'Ada Lovelace',
        email: 'ada@gmail.com',
        phoneNumber: '0801 234-5678',
      });

      expect(data.phoneNumber).toBe('+2348012345678');
      expect(data.phoneHash).toBe(phoneBlindIndex('08012345678'));
    });

    it('rejects an invalid number with a field-scoped code', async () => {
      const { prisma } = makePrisma();
      await expectRejection(
        guardUserCreate(prisma, {
          name: 'Ada Lovelace',
          email: 'ada@gmail.com',
          phoneNumber: '0801234',
        }),
        AUTH_ERROR_CODES.PHONE_INVALID,
      );
    });

    it('rejects a number already registered to another account', async () => {
      const taken = phoneBlindIndex('08012345678');
      const { prisma } = makePrisma(taken);

      await expectRejection(
        guardUserCreate(prisma, {
          name: 'Ada Lovelace',
          email: 'ada@gmail.com',
          phoneNumber: '08012345678',
        }),
        AUTH_ERROR_CODES.PHONE_ALREADY_REGISTERED,
      );
    });

    // The reason canonicalisation exists: typing the same number a different way
    // must not get you a second account on it.
    it('catches a duplicate submitted in a different spelling', async () => {
      const taken = phoneBlindIndex('08012345678');
      const { prisma } = makePrisma(taken);

      await expectRejection(
        guardUserCreate(prisma, {
          name: 'Ada Lovelace',
          email: 'ada@gmail.com',
          phoneNumber: '+234 801 234 5678',
        }),
        AUTH_ERROR_CODES.PHONE_ALREADY_REGISTERED,
      );
    });

    it('looks the number up by hash, never by the encrypted column', async () => {
      const { prisma, findUnique } = makePrisma();
      await guardUserCreate(prisma, {
        name: 'Ada Lovelace',
        email: 'ada@gmail.com',
        phoneNumber: '08012345678',
      });

      expect(findUnique).toHaveBeenCalledWith({
        where: { phoneHash: phoneBlindIndex('08012345678') },
        select: { id: true },
      });
    });

    it('skips phone handling entirely when none was supplied', async () => {
      const { prisma, findUnique } = makePrisma();
      const data = await guardUserCreate(prisma, {
        name: 'Ada Lovelace',
        email: 'ada@gmail.com',
      });

      expect(data.phoneHash).toBeUndefined();
      expect(findUnique).not.toHaveBeenCalled();
    });

    it('treats a whitespace-only phone as absent, not invalid', async () => {
      const { prisma, findUnique } = makePrisma();
      await expect(
        guardUserCreate(prisma, {
          name: 'Ada Lovelace',
          email: 'ada@gmail.com',
          phoneNumber: '   ',
        }),
      ).resolves.toMatchObject({ name: 'Ada Lovelace' });
      expect(findUnique).not.toHaveBeenCalled();
    });

    it('strips zero-width padding before checking uniqueness, so it cannot be used to smuggle a duplicate past the constraint', async () => {
      const taken = phoneBlindIndex('08012345678');
      const { prisma } = makePrisma(taken);

      await expectRejection(
        guardUserCreate(prisma, {
          name: 'Ada Lovelace',
          email: 'ada@gmail.com',
          phoneNumber: `0801${ZWSP}2345678`,
        }),
        AUTH_ERROR_CODES.PHONE_ALREADY_REGISTERED,
      );
    });
  });

  it('returns a new object rather than mutating the caller payload', async () => {
    const { prisma } = makePrisma();
    const input: UserCreateData = {
      name: '  Ada  ',
      email: 'ada@gmail.com',
      phoneNumber: '08012345678',
    };
    const data = await guardUserCreate(prisma, input);

    expect(input.name).toBe('  Ada  ');
    expect(input.phoneHash).toBeUndefined();
    expect(data).not.toBe(input);
  });

  it('preserves unrelated fields Better Auth needs', async () => {
    const { prisma } = makePrisma();
    const data = await guardUserCreate(prisma, {
      name: 'Ada Lovelace',
      email: 'ada@gmail.com',
      emailVerified: false,
      image: 'https://example.com/a.png',
    });

    expect(data.emailVerified).toBe(false);
    expect(data.image).toBe('https://example.com/a.png');
  });

  it('throws a 422, matching the status Better Auth already uses for a duplicate email', async () => {
    const { prisma } = makePrisma();
    await guardUserCreate(prisma, { name: 'A', email: 'a@b.com' }).catch(
      (error: unknown) => {
        expect((error as { status?: unknown }).status).toBe(
          'UNPROCESSABLE_ENTITY',
        );
      },
    );
  });
});

describe('guardUserUpdate', () => {
  beforeEach(() => {
    initEncryptionKey('a'.repeat(64));
  });
  afterEach(() => {
    initEncryptionKey(undefined);
  });

  // Without this, changing a number via Better Auth's own /update-user would
  // leave the old hash behind: the account keeps reserving a number it no longer
  // has, and its new number stays claimable by someone else.
  it('recomputes the blind index when the number changes', () => {
    const data = guardUserUpdate({ phoneNumber: '0801 234-5678' });

    expect(data.phoneNumber).toBe('+2348012345678');
    expect(data.phoneHash).toBe(phoneBlindIndex('08012345678'));
  });

  it('rejects an invalid number', () => {
    expect(() => guardUserUpdate({ phoneNumber: '0801' })).toThrow();
    try {
      guardUserUpdate({ phoneNumber: '0801' });
    } catch (error) {
      expect(codeOf(error)).toBe(AUTH_ERROR_CODES.PHONE_INVALID);
    }
  });

  it('sanitizes a changed name and keeps the mirror in sync', () => {
    const data = guardUserUpdate({ name: '  Ada   Lovelace  ' });
    expect(data.name).toBe('Ada Lovelace');
    expect(data.fullName).toBe('Ada Lovelace');
  });

  it('leaves an update that touches neither field alone', () => {
    const data = guardUserUpdate({ emailVerified: true });
    expect(data).toEqual({ emailVerified: true });
  });

  it('does not blank a name that sanitizes to nothing — a partial update should not clear the column', () => {
    const data = guardUserUpdate({ name: `${ZWSP}  ` });
    expect(data.name).toBe(`${ZWSP}  `);
    expect(data.fullName).toBeUndefined();
  });

  it('canonicalises consistently with the create path, so a number cannot change shape between the two', () => {
    const created = canonicalizePhone('0801 234 5678');
    const updated = guardUserUpdate({ phoneNumber: '+2348012345678' });
    expect(updated.phoneNumber).toBe(created);
  });
});
