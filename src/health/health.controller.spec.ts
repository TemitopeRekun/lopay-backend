import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { FIREBASE_STORAGE } from '../firebase/firebase.module';

describe('HealthController', () => {
  let controller: HealthController;

  const prisma = { $queryRaw: jest.fn() };
  const exists = jest.fn();
  const storage = { bucket: jest.fn(() => ({ exists })) };
  const config = { get: jest.fn() };

  function makeRes() {
    return { status: jest.fn() } as unknown as Response & {
      status: jest.Mock;
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Sensible defaults; individual tests override as needed.
    config.get.mockImplementation((key: string) => {
      if (key === 'NODE_ENV') return 'test';
      if (key === 'FIREBASE_STORAGE_BUCKET') return 'my-bucket';
      return undefined;
    });
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    exists.mockResolvedValue([true]);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: FIREBASE_STORAGE, useValue: storage },
      ],
    }).compile();
    controller = module.get<HealthController>(HealthController);
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
    });
    expect(res.status).not.toHaveBeenCalled();
    expect(storage.bucket).toHaveBeenCalledWith('my-bucket');
  });

  it('returns 503 and degraded when the DB check fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    const res = makeRes();

    const result = await controller.getHealth(res);

    expect(result.status).toBe('degraded');
    expect(result.checks.db).toEqual({ ok: false, error: 'db down' });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('reports degraded (but not 503) when storage throws', async () => {
    exists.mockRejectedValue(new Error('storage down'));
    const res = makeRes();

    const result = await controller.getHealth(res);

    expect(result.status).toBe('degraded');
    expect(result.checks.storage.ok).toBe(false);
    expect(result.checks.storage.error).toBe('storage down');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('reports degraded when the bucket does not exist', async () => {
    exists.mockResolvedValue([false]);
    const res = makeRes();

    const result = await controller.getHealth(res);

    expect(result.status).toBe('degraded');
    expect(result.checks.storage.ok).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('falls back to development env and empty bucket when config is unset', async () => {
    config.get.mockReturnValue(undefined);
    const res = makeRes();

    const result = await controller.getHealth(res);

    expect(result.nodeEnv).toBe('development');
    expect(result.checks.storage.bucket).toBe('');
    expect(storage.bucket).toHaveBeenCalledWith('');
  });
});
