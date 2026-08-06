import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/types/auth-user';

const DEFAULT_MAX = 10 * 1024 * 1024;
const UPLOAD_TTL = 7200;

type Overrides = {
  createSignedUploadUrl?: jest.Mock;
  createSignedUrl?: jest.Mock;
};

/** Build a Supabase client double whose from(bucket) storage ops are controllable. */
const makeSupabase = (over: Overrides = {}) => {
  const createSignedUploadUrl =
    over.createSignedUploadUrl ??
    jest.fn().mockResolvedValue({
      data: { signedUrl: 'https://signed', token: 'tok', path: 'p' },
      error: null,
    });
  const createSignedUrl =
    over.createSignedUrl ??
    jest.fn().mockResolvedValue({
      data: { signedUrl: 'https://signed-read' },
      error: null,
    });
  const from = jest
    .fn()
    .mockReturnValue({ createSignedUploadUrl, createSignedUrl });
  return {
    supabase: { storage: { from } },
    from,
    createSignedUploadUrl,
    createSignedUrl,
  };
};

const makeConfig = (values: Record<string, string> = {}) => ({
  get: jest.fn((key: string) => values[key]),
});

describe('DocumentsService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('constructor config parsing', () => {
    it('falls back to defaults when env is absent', async () => {
      const { supabase } = makeSupabase();
      const service = new DocumentsService(
        makeConfig() as never,
        {} as never,
        supabase as never,
      );
      const up = await service.createReceiptUploadUrl(
        'u1',
        'f.png',
        'image/png',
      );
      expect(up.maxUploadBytes).toBe(DEFAULT_MAX);
      const down = await service.createSignedUrlForPath('receipts/a.png');
      expect(down.expiresIn).toBe(600);
    });

    it('honours finite override values', async () => {
      const { supabase } = makeSupabase();
      const service = new DocumentsService(
        makeConfig({
          SUPABASE_SIGNED_URL_TTL_SECONDS: '900',
          SUPABASE_MAX_UPLOAD_BYTES: '2048',
        }) as never,
        {} as never,
        supabase as never,
      );
      const up = await service.createReceiptUploadUrl(
        'u1',
        'f.png',
        'image/png',
      );
      expect(up.maxUploadBytes).toBe(2048);
      const down = await service.createSignedUrlForPath('receipts/a.png');
      expect(down.expiresIn).toBe(900);
    });

    it('keeps defaults for non-finite TTL and non-positive max-bytes overrides', async () => {
      const { supabase } = makeSupabase();
      const service = new DocumentsService(
        makeConfig({
          SUPABASE_SIGNED_URL_TTL_SECONDS: 'notnum',
          SUPABASE_MAX_UPLOAD_BYTES: '-1',
        }) as never,
        {} as never,
        supabase as never,
      );
      const up = await service.createReceiptUploadUrl(
        'u1',
        'f.png',
        'image/png',
      );
      expect(up.maxUploadBytes).toBe(DEFAULT_MAX);
      const down = await service.createSignedUrlForPath('receipts/a.png');
      expect(down.expiresIn).toBe(600);
    });
  });

  /**
   * `createSignedUrlForPath` performs NO ownership check — it is the batch
   * helper admin reporting uses on payment rows it has already authorized. The
   * prefix guard is a backstop that keeps any future misuse inside the receipts
   * namespace instead of handing out a read URL for the whole bucket.
   */
  describe('createSignedUrlForPath (internal, unauthorized-by-design)', () => {
    const build = () => {
      const parts = makeSupabase();
      return {
        service: new DocumentsService(
          makeConfig() as never,
          {} as never,
          parts.supabase as never,
        ),
        ...parts,
      };
    };

    it.each([
      ['   ', 'blank'],
      ['private/keys.json', 'outside the receipts namespace'],
      ['receipts/../private/keys.json', 'traversing out of it'],
    ])('rejects %s (%s)', async (badPath) => {
      const { service, createSignedUrl } = build();
      await expect(
        service.createSignedUrlForPath(badPath),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(createSignedUrl).not.toHaveBeenCalled();
    });

    it('signs a genuine receipt path', async () => {
      const { service, createSignedUrl } = build();
      await service.createSignedUrlForPath('receipts/u1/abc_receipt.jpg');
      expect(createSignedUrl).toHaveBeenCalledWith(
        'receipts/u1/abc_receipt.jpg',
        600,
      );
    });
  });

  describe('createReceiptUploadUrl', () => {
    const build = (over: Overrides = {}) => {
      const parts = makeSupabase(over);
      const service = new DocumentsService(
        makeConfig() as never,
        {} as never,
        parts.supabase as never,
      );
      return { service, ...parts };
    };

    it('throws when fileName is blank', async () => {
      const { service } = build();
      await expect(
        service.createReceiptUploadUrl('u1', '   ', 'image/png'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws on an unsupported contentType', async () => {
      const { service } = build();
      await expect(
        service.createReceiptUploadUrl('u1', 'f.png', 'application/zip'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * The allow-list used to be `if (contentType && ...)`, so the one request
     * shape that declared nothing about its payload was the one that skipped
     * the check — leaving the bucket's own config as the sole gate.
     */
    it('throws when contentType is absent rather than skipping the allow-list', async () => {
      const { service, createSignedUploadUrl } = build();
      for (const missing of [undefined, '']) {
        await expect(
          service.createReceiptUploadUrl('u1', 'f.png', missing as never),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(createSignedUploadUrl).not.toHaveBeenCalled();
    });

    it('accepts a PDF receipt (bank apps export them)', async () => {
      const { service } = build();
      const res = await service.createReceiptUploadUrl(
        'u1',
        'statement.pdf',
        'application/pdf',
      );
      expect(res.path).toMatch(/^receipts\/u1\/.*_statement\.pdf$/);
    });

    it('creates a signed upload URL under receipts/<userId>/, returning token + path', async () => {
      const { service, from, createSignedUploadUrl } = build();
      const res = await service.createReceiptUploadUrl(
        'u1',
        'my file!.png',
        'image/png',
      );
      expect(from).toHaveBeenCalledWith('receipts');
      const objectPath = createSignedUploadUrl.mock.calls[0][0] as string;
      expect(objectPath).toMatch(/^receipts\/u1\/.*_my_file_\.png$/);
      expect(res.signedUrl).toBe('https://signed');
      expect(res.token).toBe('tok');
      expect(res.path).toBe(objectPath);
      expect(res.expiresIn).toBe(UPLOAD_TTL);
      expect(res.maxUploadBytes).toBe(DEFAULT_MAX);
    });

    it('falls back to "receipt" when the sanitized name is empty', async () => {
      const { service, createSignedUploadUrl } = build();
      await service.createReceiptUploadUrl('u1', '/', 'image/png');
      const objectPath = createSignedUploadUrl.mock.calls[0][0] as string;
      expect(objectPath).toMatch(/_receipt$/);
    });

    it('wraps a storage error in BadRequestException', async () => {
      const { service } = build({
        createSignedUploadUrl: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'supabase down' },
        }),
      });
      await expect(
        service.createReceiptUploadUrl('u1', 'f.png', 'image/png'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequest when storage is not configured', async () => {
      const service = new DocumentsService(
        makeConfig() as never,
        {} as never,
        null as never,
      );
      await expect(
        service.createReceiptUploadUrl('u1', 'f.png', 'image/png'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('createReceiptDownloadUrl', () => {
    const paymentWith = (over: Record<string, unknown> = {}) => ({
      id: 'p1',
      receiptUrl: 'receipts/u1/x.png',
      enrollment: {
        child: { parent: { userId: 'parent-1' } },
        school: { ownerId: 'owner-1' },
      },
      ...over,
    });

    const build = (payment: unknown, over: Overrides = {}) => {
      const parts = makeSupabase(over);
      const prisma = {
        payment: { findUnique: jest.fn().mockResolvedValue(payment) },
      };
      const service = new DocumentsService(
        makeConfig() as never,
        prisma as never,
        parts.supabase as never,
      );
      return { service, prisma, ...parts };
    };

    const parent: AuthUser = { userId: 'parent-1', role: UserRole.PARENT };
    const owner: AuthUser = { userId: 'owner-1', role: UserRole.SCHOOL_OWNER };
    const admin: AuthUser = { userId: 'root', role: UserRole.SUPER_ADMIN };

    it('404s when the payment does not exist', async () => {
      const { service } = build(null);
      await expect(
        service.createReceiptDownloadUrl('missing', parent),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when the payment has no receipt', async () => {
      const { service } = build(paymentWith({ receiptUrl: null }));
      await expect(
        service.createReceiptDownloadUrl('p1', parent),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('signs a read URL for the owning parent', async () => {
      const { service, createSignedUrl } = build(paymentWith());
      const res = await service.createReceiptDownloadUrl('p1', parent);
      expect(createSignedUrl).toHaveBeenCalledWith('receipts/u1/x.png', 600);
      expect(res.signedUrl).toBe('https://signed-read');
      expect(res.path).toBe('receipts/u1/x.png');
    });

    it('signs a read URL for the school owner', async () => {
      const { service } = build(paymentWith());
      const res = await service.createReceiptDownloadUrl('p1', owner);
      expect(res.signedUrl).toBe('https://signed-read');
    });

    it('signs a read URL for a super admin', async () => {
      const { service } = build(paymentWith());
      const res = await service.createReceiptDownloadUrl('p1', admin);
      expect(res.signedUrl).toBe('https://signed-read');
    });

    it('forbids an unrelated parent', async () => {
      const { service } = build(paymentWith());
      await expect(
        service.createReceiptDownloadUrl('p1', {
          userId: 'someone-else',
          role: UserRole.PARENT,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('wraps a storage error in BadRequestException', async () => {
      const { service } = build(paymentWith(), {
        createSignedUrl: jest
          .fn()
          .mockResolvedValue({ data: null, error: { message: 'boom' } }),
      });
      await expect(
        service.createReceiptDownloadUrl('p1', admin),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('createSignedUrlForPath', () => {
    const build = (over: Overrides = {}) => {
      const parts = makeSupabase(over);
      const service = new DocumentsService(
        makeConfig() as never,
        {} as never,
        parts.supabase as never,
      );
      return { service, ...parts };
    };

    it('throws when the path is blank', async () => {
      const { service } = build();
      await expect(service.createSignedUrlForPath('  ')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('returns a signed read URL for a valid path', async () => {
      const { service, createSignedUrl } = build();
      const res = await service.createSignedUrlForPath('receipts/a.png');
      expect(createSignedUrl).toHaveBeenCalledWith('receipts/a.png', 600);
      expect(res).toEqual({ signedUrl: 'https://signed-read', expiresIn: 600 });
    });

    it('wraps a storage error in BadRequestException', async () => {
      const { service } = build({
        createSignedUrl: jest
          .fn()
          .mockResolvedValue({ data: null, error: { message: 'boom' } }),
      });
      await expect(
        service.createSignedUrlForPath('receipts/a.png'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
