import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaystackService } from './paystack.service';

/**
 * Circuit-breaker integration (Milestone 4). We drive the breaker state
 * deterministically (manual open + mocked fetch) rather than through real
 * retry/backoff timers, so the test is fast and stable.
 */
describe('PaystackService circuit breaker', () => {
  const realFetch = global.fetch;
  let service: PaystackService;

  const breakerOf = (s: PaystackService) =>
    (
      s as unknown as {
        breaker: { open(): void; close(): void; opened: boolean };
      }
    ).breaker;

  beforeEach(() => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_dummy';
    service = new PaystackService();
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('fails fast with 503 while the circuit is OPEN', async () => {
    breakerOf(service).open();
    await expect(service.listBanks()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('passes through and returns data once the circuit is CLOSED again', async () => {
    breakerOf(service).open();
    breakerOf(service).close();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        data: [{ name: 'GTB', code: '058', currency: 'NGN' }],
      }),
    }) as unknown as typeof fetch;

    await expect(service.listBanks()).resolves.toEqual([
      { name: 'GTB', code: '058', currency: 'NGN' },
    ]);
  });

  it('surfaces a 4xx as BadGateway and does NOT open the circuit (errorFilter)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ status: false, message: 'Invalid bank code' }),
    }) as unknown as typeof fetch;

    // Fire well past the volumeThreshold — business errors must never trip it.
    for (let i = 0; i < 8; i += 1) {
      await expect(
        service.resolveAccount('0001', '058'),
      ).rejects.toBeInstanceOf(BadGatewayException);
    }
    expect(breakerOf(service).opened).toBe(false);
  });
});
