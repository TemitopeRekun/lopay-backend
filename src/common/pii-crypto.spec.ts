import { initEncryptionKey, encrypt, decrypt } from './encryption';
import {
  PII_FIELDS,
  isWriteOperation,
  encryptPiiInArgs,
  decryptPiiDeep,
} from './pii-crypto';

const VALID_KEY = 'b'.repeat(64);

/** A base64 GCM blob is our ciphertext; anything else fails the auth check. */
function isCiphertext(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    decrypt(value);
    return true;
  } catch {
    return false;
  }
}

describe('pii-crypto', () => {
  beforeAll(() => initEncryptionKey(VALID_KEY));
  afterAll(() => initEncryptionKey(undefined));

  describe('isWriteOperation', () => {
    it('classifies write vs read operations', () => {
      expect(isWriteOperation('create')).toBe(true);
      expect(isWriteOperation('update')).toBe(true);
      expect(isWriteOperation('upsert')).toBe(true);
      expect(isWriteOperation('createMany')).toBe(true);
      expect(isWriteOperation('findMany')).toBe(false);
      expect(isWriteOperation('count')).toBe(false);
    });
  });

  describe('encryptPiiInArgs', () => {
    it('encrypts PII scalars in create data, leaving non-PII untouched', () => {
      const args = { data: { phoneNumber: '+2348012345678', fullName: 'Ada' } };
      encryptPiiInArgs('create', args);
      expect(isCiphertext(args.data.phoneNumber)).toBe(true);
      expect(decrypt(args.data.phoneNumber)).toBe('+2348012345678');
      expect(args.data.fullName).toBe('Ada');
    });

    it('does nothing for read operations', () => {
      const args = { where: { phoneNumber: '+234' } };
      encryptPiiInArgs('findFirst', args);
      expect(args.where.phoneNumber).toBe('+234');
    });

    it('encrypts data but never the where clause on update', () => {
      const args = {
        where: { phoneNumber: '+234lookup' },
        data: { phoneNumber: '+234new', bankName: 'GTB' },
      };
      encryptPiiInArgs('update', args);
      expect(args.where.phoneNumber).toBe('+234lookup'); // untouched
      expect(decrypt(args.data.phoneNumber)).toBe('+234new');
      expect(decrypt(args.data.bankName)).toBe('GTB');
    });

    it('handles the { set: ... } scalar-update form', () => {
      const args = { data: { accountNumber: { set: '0123456789' } } };
      encryptPiiInArgs('update', args);
      expect(decrypt(args.data.accountNumber.set)).toBe('0123456789');
    });

    it('encrypts both branches of an upsert', () => {
      const args = {
        create: { phone: '+234create' },
        update: { phone: '+234update' },
      };
      encryptPiiInArgs('upsert', args);
      expect(decrypt(args.create.phone)).toBe('+234create');
      expect(decrypt(args.update.phone)).toBe('+234update');
    });

    it('encrypts every row of createMany', () => {
      const args = { data: [{ phone: '+2341' }, { phone: '+2342' }] };
      encryptPiiInArgs('createMany', args);
      expect(decrypt(args.data[0].phone)).toBe('+2341');
      expect(decrypt(args.data[1].phone)).toBe('+2342');
    });

    it('recurses into nested relation writes', () => {
      const args = {
        data: {
          userId: 'u1',
          parent: { create: { phoneNumber: '+234nested' } },
          school: {
            connectOrCreate: {
              where: { id: 's1' },
              create: { accountNumber: '999', bankName: 'Zenith' },
            },
          },
        },
      };
      encryptPiiInArgs('create', args);
      expect(decrypt(args.data.parent.create.phoneNumber)).toBe('+234nested');
      expect(
        decrypt(args.data.school.connectOrCreate.create.accountNumber),
      ).toBe('999');
      expect(decrypt(args.data.school.connectOrCreate.create.bankName)).toBe(
        'Zenith',
      );
    });

    it('recurses into nested update ({ where, data }), upsert, createMany and updateMany forms', () => {
      const args = {
        data: {
          name: 'Acme',
          owner: { update: { where: { id: 'u1' }, data: { phone: '+234u' } } },
          parents: {
            upsert: [
              {
                where: { id: 'p1' },
                create: { phoneNumber: '+234c' },
                update: { phoneNumber: '+234up' },
              },
            ],
            createMany: { data: [{ phoneNumber: '+234cm' }] },
            updateMany: [
              { where: { id: 'p2' }, data: { phoneNumber: '+234um' } },
            ],
          },
        },
      };
      encryptPiiInArgs('update', args);
      expect(decrypt(args.data.owner.update.data.phone)).toBe('+234u');
      expect(decrypt(args.data.parents.upsert[0].create.phoneNumber)).toBe(
        '+234c',
      );
      expect(decrypt(args.data.parents.upsert[0].update.phoneNumber)).toBe(
        '+234up',
      );
      expect(decrypt(args.data.parents.createMany.data[0].phoneNumber)).toBe(
        '+234cm',
      );
      expect(decrypt(args.data.parents.updateMany[0].data.phoneNumber)).toBe(
        '+234um',
      );
    });

    it('handles a nested update given directly as a data object (no where wrapper)', () => {
      const args = {
        data: { owner: { update: { phone: '+234direct' } } },
      };
      encryptPiiInArgs('update', args);
      expect(decrypt(args.data.owner.update.phone)).toBe('+234direct');
    });

    it('never encrypts values inside connect (equality lookups)', () => {
      const args = {
        data: {
          phone: '+234',
          owner: { connect: { id: 'u1' } },
        },
      };
      encryptPiiInArgs('create', args);
      expect(decrypt(args.data.phone)).toBe('+234'); // encrypted
      expect(args.data.owner.connect.id).toBe('u1'); // untouched
    });

    it('tolerates args without a data payload', () => {
      const args = { where: { id: 'x' } };
      expect(() => encryptPiiInArgs('update', args)).not.toThrow();
    });
  });

  describe('decryptPiiDeep', () => {
    it('decrypts a flat record', () => {
      const record = { id: 'u1', phoneNumber: encrypt('+2348011112222') };
      decryptPiiDeep(record);
      expect(record.phoneNumber).toBe('+2348011112222');
    });

    it('decrypts PII buried in nested includes', () => {
      const payment = {
        id: 'p1',
        amountPaid: 1000,
        enrollment: {
          id: 'e1',
          school: {
            accountNumber: encrypt('0123456789'),
            bankName: encrypt('GTBank'),
            name: 'Acme School', // not PII
          },
          child: {
            parent: {
              user: { phoneNumber: encrypt('+2349000000000') },
            },
          },
        },
      };
      decryptPiiDeep(payment);
      expect(payment.enrollment.school.accountNumber).toBe('0123456789');
      expect(payment.enrollment.school.bankName).toBe('GTBank');
      expect(payment.enrollment.school.name).toBe('Acme School');
      expect(payment.enrollment.child.parent.user.phoneNumber).toBe(
        '+2349000000000',
      );
    });

    it('decrypts arrays of records', () => {
      const rows = [
        { phone: encrypt('+2341111') },
        { phone: encrypt('+2342222') },
      ];
      decryptPiiDeep(rows);
      expect(rows[0].phone).toBe('+2341111');
      expect(rows[1].phone).toBe('+2342222');
    });

    it('leaves non-ciphertext (plaintext) values unchanged', () => {
      const record = { phoneNumber: '+234-legacy-plaintext' };
      decryptPiiDeep(record);
      expect(record.phoneNumber).toBe('+234-legacy-plaintext');
    });

    it('does not recurse into non-plain objects (Date/Decimal)', () => {
      const now = new Date();
      const record = { createdAt: now, phoneNumber: encrypt('+234') };
      decryptPiiDeep(record);
      expect(record.createdAt).toBe(now);
      expect(record.phoneNumber).toBe('+234');
    });

    it('returns primitives and null unchanged', () => {
      expect(decryptPiiDeep(null)).toBeNull();
      expect(decryptPiiDeep(42)).toBe(42);
      expect(decryptPiiDeep('plain')).toBe('plain');
    });
  });

  describe('round-trip through a simulated store', () => {
    it('write-encrypt then read-decrypt returns the original', () => {
      const args = {
        data: { phoneNumber: '+2348090000000', accountName: 'Ada Lovelace' },
      };
      encryptPiiInArgs('create', args);
      // Simulate what the DB returns (the encrypted row).
      const stored = { ...args.data };
      decryptPiiDeep(stored);
      expect(stored.phoneNumber).toBe('+2348090000000');
      expect(stored.accountName).toBe('Ada Lovelace');
    });
  });

  it('exposes the expected PII field set', () => {
    expect([...PII_FIELDS].sort()).toEqual([
      'accountName',
      'accountNumber',
      'bankName',
      'phone',
      'phoneNumber',
    ]);
  });
});
