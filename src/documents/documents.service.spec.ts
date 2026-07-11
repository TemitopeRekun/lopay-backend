import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/types/auth-user';

const DEFAULT_MAX = 10 * 1024 * 1024;

/** Build a Storage double whose bucket().file().getSignedUrl() is controllable. */
const makeStorage = (
  getSignedUrl: jest.Mock = jest.fn().mockResolvedValue(['https://signed']),
) => {
  const file = jest.fn().mockReturnValue({ getSignedUrl });
  const bucket = jest.fn().mockReturnValue({ file });
  return { storage: { bucket }, bucket, file, getSignedUrl };
};

const makeConfig = (values: Record<string, string> = {}) => ({
  get: jest.fn((key: string) => values[key]),
});

describe('DocumentsService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('constructor config parsing', () => {
    it('falls back to defaults when env is absent', async () => {
      const { storage } = makeStorage();
      const service = new DocumentsService(
        makeConfig() as never,
        {} as never,
        storage as never,
      );
      const res = await service.createReceiptUploadUrl(
        'u1',
        'file.png',
        'image/png',
      );
      expect(res.expiresIn).toBe(600);
      expect(res.maxUploadBytes).toBe(DEFAULT_MAX);
    });

    it('honours finite override values', async () => {
      const { storage } = makeStorage();
      const service = new DocumentsService(
        makeConfig({
          FIREBASE_SIGNED_URL_TTL_SECONDS: '900',
          FIREBASE_MAX_UPLOAD_BYTES: '2048',
        }) as never,
        {} as never,
        storage as never,
      );
      const res = await service.createReceiptUploadUrl('u1', 'file.png');
      expect(res.expiresIn).toBe(900);
      expect(res.maxUploadBytes).toBe(2048);
    });

    it('keeps defaults for non-finite TTL and non-positive max-bytes overrides', async () => {
      const { storage } = makeStorage();
      const service = new DocumentsService(
        makeConfig({
          FIREBASE_SIGNED_URL_TTL_SECONDS: 'notnum',
          FIREBASE_MAX_UPLOAD_BYTES: '-1',
        }) as never,
        {} as never,
        storage as never,
      );
      const res = await service.createReceiptUploadUrl('u1', 'file.png');
      expect(res.expiresIn).toBe(600);
      expect(res.maxUploadBytes).toBe(DEFAULT_MAX);
    });
  });

  describe('createReceiptUploadUrl', () => {
    const build = (
      getSignedUrl = jest.fn().mockResolvedValue(['https://signed']),
    ) => {
      const parts = makeStorage(getSignedUrl);
      const service = new DocumentsService(
        makeConfig() as never,
        {} as never,
        parts.storage as never,
      );
      return { service, ...parts };
    };

    it('throws when fileName is blank', async () => {
      const { service } = build();
      await expect(
        service.createReceiptUploadUrl('u1', '   '),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws on an unsupported contentType', async () => {
      const { service } = build();
      await expect(
        service.createReceiptUploadUrl('u1', 'f.png', 'application/zip'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a v4 write URL with the content-length range bound into the signature', async () => {
      const { service, file, getSignedUrl } = build();
      const res = await service.createReceiptUploadUrl(
        'u1',
        'my file!.png',
        'image/png',
      );
      const objectPath = file.mock.calls[0][0] as string;
      expect(objectPath).toMatch(/^receipts\/u1\/.*_my_file_\.png$/);
      const opts = getSignedUrl.mock.calls[0][0];
      expect(opts.action).toBe('write');
      expect(opts.version).toBe('v4');
      expect(opts.contentType).toBe('image/png');
      expect(opts.extensionHeaders['x-goog-content-length-range']).toBe(
        `0,${DEFAULT_MAX}`,
      );
      expect(res.signedUrl).toBe('https://signed');
      expect(res.path).toBe(objectPath);
      expect(res.requiredHeaders['x-goog-content-length-range']).toBe(
        `0,${DEFAULT_MAX}`,
      );
    });

    it('defaults contentType to image/jpeg when omitted', async () => {
      const { service, getSignedUrl } = build();
      await service.createReceiptUploadUrl('u1', 'file.png');
      expect(getSignedUrl.mock.calls[0][0].contentType).toBe('image/jpeg');
    });

    it('falls back to "receipt" when the sanitized name is empty', async () => {
      const { service, file } = build();
      await service.createReceiptUploadUrl('u1', '/');
      const objectPath = file.mock.calls[0][0] as string;
      expect(objectPath).toMatch(/_receipt$/);
    });

    it('wraps a storage failure in BadRequestException', async () => {
      const { service } = build(
        jest.fn().mockRejectedValue(new Error('gcs down')),
      );
      await expect(
        service.createReceiptUploadUrl('u1', 'file.png'),
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

    const build = (
      payment: unknown,
      getSignedUrl = jest.fn().mockResolvedValue(['https://signed-read']),
    ) => {
      const parts = makeStorage(getSignedUrl);
      const prisma = {
        payment: { findUnique: jest.fn().mockResolvedValue(payment) },
      };
      const service = new DocumentsService(
        makeConfig() as never,
        prisma as never,
        parts.storage as never,
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
      const { service, getSignedUrl } = build(paymentWith());
      const res = await service.createReceiptDownloadUrl('p1', parent);
      expect(getSignedUrl.mock.calls[0][0].action).toBe('read');
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

    it('wraps a storage failure in BadRequestException', async () => {
      const { service } = build(
        paymentWith(),
        jest.fn().mockRejectedValue(new Error('gcs down')),
      );
      await expect(
        service.createReceiptDownloadUrl('p1', admin),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('createSignedUrlForPath', () => {
    const build = (
      getSignedUrl = jest.fn().mockResolvedValue(['https://signed-path']),
    ) => {
      const parts = makeStorage(getSignedUrl);
      const service = new DocumentsService(
        makeConfig() as never,
        {} as never,
        parts.storage as never,
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
      const { service, getSignedUrl } = build();
      const res = await service.createSignedUrlForPath('receipts/a.png');
      expect(getSignedUrl.mock.calls[0][0].action).toBe('read');
      expect(res).toEqual({ signedUrl: 'https://signed-path', expiresIn: 600 });
    });

    it('wraps a storage failure in BadRequestException', async () => {
      const { service } = build(jest.fn().mockRejectedValue(new Error('boom')));
      await expect(
        service.createSignedUrlForPath('receipts/a.png'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
