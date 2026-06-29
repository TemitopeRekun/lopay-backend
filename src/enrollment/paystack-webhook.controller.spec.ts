import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import type { Request } from 'express';
import { PaystackWebhookController } from './paystack-webhook.controller';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/types/auth-user';

const SECRET = 'sk_test_secret';

/** Sign a raw body exactly as Paystack does (HMAC-SHA512 over the raw bytes). */
function sign(raw: Buffer, secret = SECRET): string {
  return createHmac('sha512', secret).update(raw).digest('hex');
}

/** Minimal Express-like request carrying the raw body + headers the guard reads. */
function makeReq(raw: Buffer, headers: Record<string, string> = {}): Request {
  return {
    headers,
    rawBody: raw,
    ip: '1.2.3.4',
    socket: { remoteAddress: '1.2.3.4' },
  } as unknown as Request;
}

describe('PaystackWebhookController', () => {
  let controller: PaystackWebhookController;
  const enrollment = {
    processPaystackWebhookEvent: jest.fn().mockResolvedValue({ ok: true }),
    reconcilePaystackPayment: jest.fn().mockResolvedValue({ reconciled: true }),
    failPaystackPayment: jest.fn().mockResolvedValue({ failed: true }),
    assertReferenceOwnedBy: jest.fn().mockResolvedValue(undefined),
  };
  const paystack = {
    verifyTransaction: jest.fn(),
  };

  const parent: AuthUser = {
    userId: 'parent-1',
    role: UserRole.PARENT,
    schoolId: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PAYSTACK_SECRET_KEY = SECRET;
    delete process.env.PAYSTACK_WEBHOOK_ALLOWED_IPS;
    controller = new PaystackWebhookController(
      enrollment as never,
      paystack as never,
    );
  });

  describe('webhook (HMAC verification)', () => {
    it('accepts a valid signature and dispatches the parsed event', async () => {
      const raw = Buffer.from(
        JSON.stringify({ event: 'charge.success', data: { reference: 'r1' } }),
      );
      const res = await controller.webhook(makeReq(raw), sign(raw));
      expect(enrollment.processPaystackWebhookEvent).toHaveBeenCalledWith({
        event: 'charge.success',
        data: { reference: 'r1' },
      });
      expect(res).toEqual({ ok: true });
    });

    it('rejects a tampered signature with 401', async () => {
      const raw = Buffer.from(JSON.stringify({ event: 'charge.success' }));
      const bad = sign(raw, 'wrong-secret');
      await expect(
        controller.webhook(makeReq(raw), bad),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(enrollment.processPaystackWebhookEvent).not.toHaveBeenCalled();
    });

    it('rejects a short signature with 401 (length mismatch)', async () => {
      const raw = Buffer.from(JSON.stringify({ event: 'charge.success' }));
      await expect(
        controller.webhook(makeReq(raw), 'abc'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an empty signature with 401', async () => {
      const raw = Buffer.from(JSON.stringify({ event: 'charge.success' }));
      await expect(controller.webhook(makeReq(raw), '')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('fails loudly (500) when the signing secret is missing', async () => {
      delete process.env.PAYSTACK_SECRET_KEY;
      const raw = Buffer.from(JSON.stringify({ event: 'charge.success' }));
      await expect(
        controller.webhook(makeReq(raw), sign(raw)),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('fails loudly (500) when the raw body is unavailable', async () => {
      const req = {
        headers: {},
        rawBody: undefined,
        ip: '1.2.3.4',
        socket: {},
      } as unknown as Request;
      await expect(controller.webhook(req, 'anything')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('rejects a non-JSON (but correctly signed) body with 400', async () => {
      const raw = Buffer.from('not-json');
      await expect(
        controller.webhook(makeReq(raw), sign(raw)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allows a request from an allowlisted IP', async () => {
      process.env.PAYSTACK_WEBHOOK_ALLOWED_IPS = '9.9.9.9, 1.2.3.4';
      const raw = Buffer.from(JSON.stringify({ event: 'charge.success' }));
      await controller.webhook(
        makeReq(raw, { 'x-forwarded-for': '1.2.3.4' }),
        sign(raw),
      );
      expect(enrollment.processPaystackWebhookEvent).toHaveBeenCalled();
    });

    it('rejects a request from a disallowed IP with 401', async () => {
      process.env.PAYSTACK_WEBHOOK_ALLOWED_IPS = '9.9.9.9';
      const raw = Buffer.from(JSON.stringify({ event: 'charge.success' }));
      await expect(
        controller.webhook(
          makeReq(raw, { 'x-forwarded-for': '1.2.3.4' }),
          sign(raw),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(enrollment.processPaystackWebhookEvent).not.toHaveBeenCalled();
    });
  });

  describe('verify (ownership scoping)', () => {
    it('requires a reference', async () => {
      await expect(controller.verify('', parent)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('checks ownership BEFORE touching Paystack', async () => {
      enrollment.assertReferenceOwnedBy.mockRejectedValueOnce(
        new ForbiddenException(),
      );
      await expect(controller.verify('r1', parent)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(enrollment.assertReferenceOwnedBy).toHaveBeenCalledWith(
        'r1',
        parent,
      );
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    });

    it('propagates a NotFound for an unknown reference without reconciling', async () => {
      enrollment.assertReferenceOwnedBy.mockRejectedValueOnce(
        new NotFoundException(),
      );
      await expect(controller.verify('nope', parent)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    });

    it('reconciles an owned, successful payment', async () => {
      paystack.verifyTransaction.mockResolvedValueOnce({
        status: 'success',
        fees: 1500,
      });
      const res = await controller.verify('r1', parent);
      expect(enrollment.assertReferenceOwnedBy).toHaveBeenCalledWith(
        'r1',
        parent,
      );
      expect(enrollment.reconcilePaystackPayment).toHaveBeenCalledWith(
        'r1',
        1500,
        null,
      );
      expect(res).toEqual({ status: 'success', reference: 'r1' });
    });

    it('fails an owned, failed payment', async () => {
      paystack.verifyTransaction.mockResolvedValueOnce({
        status: 'failed',
        fees: null,
      });
      const res = await controller.verify('r1', parent);
      expect(enrollment.failPaystackPayment).toHaveBeenCalledWith('r1');
      expect(res).toEqual({ status: 'failed', reference: 'r1' });
    });
  });
});
