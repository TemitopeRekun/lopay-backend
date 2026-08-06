import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { SUPABASE_CLIENT } from '../supabase/supabase.module';

describe('HealthController', () => {
  let controller: HealthController;

  const prisma = { $queryRaw: jest.fn() };
  const getBucket = jest.fn();
  const supabase = { storage: { getBucket } };
  const config = { get: jest.fn() };

  function makeRes() {
    return { status: jest.fn() } as unknown as Response & {
      status: jest.Mock;
    };
  }

  const build = async (supabaseClient: unknown = supabase) => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: SUPABASE_CLIENT, useValue: supabaseClient },
      ],
    }).compile();
    return module.get<HealthController>(HealthController);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Sensible defaults; individual tests override as needed.
    config.get.mockImplementation((key: string) => {
      if (key === 'NODE_ENV') return 'test';
      if (key === 'SUPABASE_STORAGE_BUCKET') return 'my-bucket';
      return undefined;
    });
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    // A correctly configured receipts bucket: private, size-capped, MIME-capped.
    // Those three are the only enforcement receipt uploads have — the browser
    // PUTs straight to storage on a signed URL, so no code in this repo sees
    // the bytes.
    getBucket.mockResolvedValue({
      data: {
        name: 'my-bucket',
        public: false,
        file_size_limit: 10 * 1024 * 1024,
        allowed_mime_types: ['image/jpeg', 'image/png', 'application/pdf'],
      },
      error: null,
    });
    controller = await build();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports ok when the DB and storage are both healthy', async () => {
    const res = makeRes();
    const result = await controller.getHealth(res);

    expect(result.status).toBe('ok');
    expect(result.nodeEnv).toBe('test');
    expect(result.checks.db).toEqual({ ok: true, error: undefined });
    expect(result.checks.storage).toEqual({
      ok: true,
      bucket: 'my-bucket',
      error: undefined,
      config: { ok: true, issues: [] },
    });
    expect(res.status).not.toHaveBeenCalled();
    expect(getBucket).toHaveBeenCalledWith('my-bucket');
  });

  /**
   * The bucket's own settings are the ONLY thing enforcing receipt size/type,
   * and the only thing keeping payer bank details out of public URLs. Nothing
   * in this repo can assert them at upload time, so surfacing them here is the
   * whole mechanism — a silent `ok` on a wide-open bucket is the failure.
   */
  it('flags a public or unbounded receipts bucket as degraded', async () => {
    getBucket.mockResolvedValue({
      data: {
        name: 'my-bucket',
        public: true,
        file_size_limit: null,
        allowed_mime_types: [],
      },
      error: null,
    });
    const res = makeRes();

    const result = await controller.getHealth(res);

    expect(result.status).toBe('degraded');
    // Reachability is unaffected — uploads still work, so this is not a 503.
    expect(result.checks.storage.ok).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(result.checks.storage.config.ok).toBe(false);
    expect(result.checks.storage.config.issues).toEqual([
      expect.stringContaining('bucket_is_public'),
      'no_file_size_limit',
      'no_allowed_mime_types',
    ]);
  });

  it('returns 503 and degraded when the DB check fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    const res = makeRes();

    const result = await controller.getHealth(res);

    expect(result.status).toBe('degraded');
    expect(result.checks.db).toEqual({ ok: false, error: 'db down' });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('reports degraded (but not 503) when storage returns an error', async () => {
    getBucket.mockResolvedValue({
      data: null,
      error: { message: 'storage down' },
    });
    const res = makeRes();

    const result = await controller.getHealth(res);

    expect(result.status).toBe('degraded');
    expect(result.checks.storage.ok).toBe(false);
    expect(result.checks.storage.error).toBe('storage down');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('reports degraded when the storage call rejects', async () => {
    getBucket.mockRejectedValue(new Error('boom'));
    const res = makeRes();

    const result = await controller.getHealth(res);

    expect(result.status).toBe('degraded');
    expect(result.checks.storage.ok).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('reports storage not_configured when Supabase is disabled', async () => {
    controller = await build(null);
    const res = makeRes();

    const result = await controller.getHealth(res);

    expect(result.checks.storage.ok).toBe(false);
    expect(result.checks.storage.error).toBe('not_configured');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('falls back to development env and the default bucket when config is unset', async () => {
    config.get.mockReturnValue(undefined);
    const res = makeRes();

    const result = await controller.getHealth(res);

    expect(result.nodeEnv).toBe('development');
    expect(result.checks.storage.bucket).toBe('receipts');
    expect(getBucket).toHaveBeenCalledWith('receipts');
  });
});
