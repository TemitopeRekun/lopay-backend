import { CacheService } from './cache.service';

describe('CacheService', () => {
  describe('in-memory fallback (REDIS_CLIENT = null)', () => {
    let cache: CacheService;
    beforeEach(() => {
      cache = new CacheService(null);
    });

    it('runs the loader once, then serves cached hits (no second load)', async () => {
      const loader = jest.fn().mockResolvedValue({ v: 1 });
      const a = await cache.getOrSet('k', 60, loader);
      const b = await cache.getOrSet('k', 60, loader);
      expect(a).toEqual({ v: 1 });
      expect(b).toEqual({ v: 1 });
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('reloads after del() invalidates the key', async () => {
      const loader = jest
        .fn()
        .mockResolvedValueOnce('first')
        .mockResolvedValueOnce('second');
      await cache.getOrSet('k', 60, loader);
      await cache.del('k');
      const after = await cache.getOrSet('k', 60, loader);
      expect(after).toBe('second');
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('treats an expired entry as a miss', async () => {
      const loader = jest
        .fn()
        .mockResolvedValueOnce('a')
        .mockResolvedValueOnce('b');
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
      await cache.getOrSet('k', 10, loader); // expires at 11_000
      now.mockReturnValue(20_000); // past expiry
      const after = await cache.getOrSet('k', 10, loader);
      expect(after).toBe('b');
      expect(loader).toHaveBeenCalledTimes(2);
      now.mockRestore();
    });
  });

  describe('Redis-backed', () => {
    it('returns the parsed cached value WITHOUT calling the loader on a hit', async () => {
      const redis = {
        get: jest.fn().mockResolvedValue(JSON.stringify({ v: 42 })),
        set: jest.fn(),
        del: jest.fn(),
      };
      const cache = new CacheService(redis as never);
      const loader = jest.fn();
      const out = await cache.getOrSet('k', 60, loader);
      expect(out).toEqual({ v: 42 });
      expect(loader).not.toHaveBeenCalled();
      expect(redis.get).toHaveBeenCalledWith('k');
    });

    it('loads and SETs with EX ttl on a miss', async () => {
      const redis = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn(),
      };
      const cache = new CacheService(redis as never);
      const out = await cache.getOrSet('k', 30, async () => ({ v: 7 }));
      expect(out).toEqual({ v: 7 });
      expect(redis.set).toHaveBeenCalledWith(
        'k',
        JSON.stringify({ v: 7 }),
        'EX',
        30,
      );
    });

    it('falls through to a miss (still loads) when Redis get throws', async () => {
      const redis = {
        get: jest.fn().mockRejectedValue(new Error('down')),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn(),
      };
      const cache = new CacheService(redis as never);
      const out = await cache.getOrSet('k', 30, async () => 'loaded');
      expect(out).toBe('loaded');
    });
  });
});
