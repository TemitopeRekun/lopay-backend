import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaystackApiError, PaystackService } from './paystack.service';

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

  /**
   * Callers have to act differently on different 4xx verdicts — "this reference
   * doesn't exist" is safe to treat as terminal, "your key is wrong" absolutely
   * is not. Carrying the status and raw message is what lets them do that
   * without parsing a formatted string.
   */
  describe('PaystackApiError', () => {
    const rejectWith = (status: number, message: string) => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status,
        json: async () => ({ status: false, message }),
      }) as unknown as typeof fetch;
    };

    it('carries the provider status and message, and stays a BadGateway', async () => {
      rejectWith(400, 'Transaction reference not found.');

      const err = await service.verifyTransaction('lopay_x').catch((e) => e);

      expect(err).toBeInstanceOf(PaystackApiError);
      expect(err).toBeInstanceOf(BadGatewayException);
      expect(err.providerStatus).toBe(400);
      expect(err.paystackMessage).toBe('Transaction reference not found.');
      // ...while the exception itself still presents as a 502 to our own clients.
      expect(err.getStatus()).toBe(502);
      expect(err.message).toBe(
        'Paystack error (400): Transaction reference not found.',
      );
    });

    /*
     * `getSubaccount` is what tells an admin whether a school can be paid today.
     * "Not on this integration" must be a clean null, but an outage or a rejected
     * key must NOT be — reporting those as "doesn't exist" would have an admin
     * re-provisioning healthy schools and orphaning their real payout accounts.
     */
    describe('getSubaccount', () => {
      it('returns null when the subaccount is not on this integration', async () => {
        rejectWith(404, 'Subaccount not found');
        await expect(service.getSubaccount('ACCT_gone')).resolves.toBeNull();
      });

      it('rethrows when Paystack rejects the key', async () => {
        rejectWith(401, 'Invalid key');
        await expect(service.getSubaccount('ACCT_x')).rejects.toBeInstanceOf(
          PaystackApiError,
        );
      });

      it('returns the subaccount when it exists', async () => {
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: { subaccount_code: 'ACCT_ok', business_name: 'Acme' },
          }),
        }) as unknown as typeof fetch;

        await expect(service.getSubaccount('ACCT_ok')).resolves.toEqual(
          expect.objectContaining({ subaccount_code: 'ACCT_ok' }),
        );
      });
    });

    it('flags an unknown reference, but never an auth failure', async () => {
      expect(
        new PaystackApiError(400, 'Transaction reference not found.')
          .isUnknownReference,
      ).toBe(true);
      expect(
        new PaystackApiError(404, 'Transaction not found').isUnknownReference,
      ).toBe(true);
      // The dangerous one: a wrong key must not read as "no such transaction".
      expect(new PaystackApiError(401, 'Invalid key').isUnknownReference).toBe(
        false,
      );
      expect(
        new PaystackApiError(400, 'Invalid subaccount').isUnknownReference,
      ).toBe(false);
    });
  });

  /**
   * `gateway_response` is Paystack's own reason for the outcome, and the only
   * source of WHY a charge failed — `status` alone is just "failed". It is
   * rendered verbatim to the parent on the post-payment screen, so the mapping
   * (and its absence) has to be exact.
   */
  describe('verifyTransaction', () => {
    const respondWith = (data: Record<string, unknown>) => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: true, data }),
      }) as unknown as typeof fetch;
    };

    it("carries Paystack's decline reason through", async () => {
      respondWith({
        status: 'failed',
        reference: 'lopay_1',
        amount: 2_800_000,
        gateway_response: 'Insufficient funds',
      });

      const result = await service.verifyTransaction('lopay_1');

      expect(result.status).toBe('failed');
      expect(result.gatewayResponse).toBe('Insufficient funds');
    });

    /**
     * Null, not "" — the screen renders the reason box on truthiness, so an
     * empty string would draw an empty "Reason from your bank" panel.
     */
    it.each([
      ['absent', undefined],
      ['empty', ''],
      ['not a string', 42],
    ])('reports a %s reason as null', async (_label, value) => {
      respondWith({
        status: 'failed',
        reference: 'lopay_1',
        amount: 2_800_000,
        gateway_response: value,
      });

      await expect(service.verifyTransaction('lopay_1')).resolves.toMatchObject(
        { gatewayResponse: null },
      );
    });

    it('still reports the authoritative fee alongside it', async () => {
      respondWith({
        status: 'success',
        reference: 'lopay_1',
        amount: 2_800_000,
        fees: 42_000,
        gateway_response: 'Successful',
      });

      const result = await service.verifyTransaction('lopay_1');

      expect(result).toMatchObject({
        status: 'success',
        fees: 42_000,
        gatewayResponse: 'Successful',
      });
    });
  });
});
