import { withTimeout, withRetry } from './resilience';

describe('resilience', () => {
  describe('withTimeout', () => {
    it('resolves with the value when the promise settles in time', async () => {
      await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe(
        'ok',
      );
    });

    it('rejects with a labelled timeout error when the promise is too slow', async () => {
      const never = new Promise<string>(() => {});
      await expect(withTimeout(never, 10, 'slow-op')).rejects.toThrow(
        /slow-op timed out after 10ms/,
      );
    });

    it('propagates the original rejection', async () => {
      await expect(
        withTimeout(Promise.reject(new Error('boom')), 1000),
      ).rejects.toThrow('boom');
    });
  });

  describe('withRetry', () => {
    it('returns the value on the first successful attempt (no retry)', async () => {
      const fn = jest.fn().mockResolvedValue('done');
      await expect(withRetry(fn)).resolves.toBe('done');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries after a failure and then succeeds', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce('recovered');

      await expect(withRetry(fn, { maxAttempts: 2 })).resolves.toBe(
        'recovered',
      );
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws the last error after exhausting all attempts', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('permanent'));
      await expect(withRetry(fn, { maxAttempts: 1 })).rejects.toThrow(
        'permanent',
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not retry when shouldRetry returns false', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fatal'));
      const shouldRetry = jest.fn().mockReturnValue(false);

      await expect(
        withRetry(fn, { maxAttempts: 3, shouldRetry }),
      ).rejects.toThrow('fatal');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(shouldRetry).toHaveBeenCalled();
    });
  });
});
