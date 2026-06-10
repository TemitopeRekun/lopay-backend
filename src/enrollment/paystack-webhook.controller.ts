import {
  Controller,
  Post,
  Get,
  Req,
  Query,
  Headers,
  HttpCode,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';
import { UserRole } from '../generated/prisma/client';
import { EnrollmentService } from './enrollment.service';
import { PaystackService } from '../paystack/paystack.service';

/**
 * Paystack callbacks for first payments. The webhook is the source of truth for
 * activation; the verify endpoint is a belt-and-braces reconciliation the
 * frontend calls on return (handles delayed webhooks). Both run the same
 * idempotent reconciliation in EnrollmentService.
 */
@Controller('payments/paystack')
export class PaystackWebhookController {
  private readonly logger = new Logger(PaystackWebhookController.name);

  constructor(
    private readonly enrollment: EnrollmentService,
    private readonly paystack: PaystackService,
  ) {}

  /**
   * Webhook. Public (no JWT) — authenticity is proven by the HMAC-SHA512
   * signature over the RAW request body (see main.ts raw-body mounting).
   */
  @Public()
  @SkipThrottle()
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: Request,
    @Headers('x-paystack-signature') signature: string,
  ) {
    // Defense-in-depth: if an allowlist is configured, only accept webhooks from
    // Paystack's published IPs. The HMAC below remains the primary control.
    const allowedIps = (process.env.PAYSTACK_WEBHOOK_ALLOWED_IPS ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);
    if (allowedIps.length > 0) {
      const fwd = req.headers['x-forwarded-for'];
      const clientIp = (
        (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0] ??
        req.ip ??
        req.socket?.remoteAddress ??
        ''
      ).trim();
      if (!allowedIps.includes(clientIp)) {
        this.logger.warn(`Rejected Paystack webhook from disallowed IP: ${clientIp}`);
        throw new UnauthorizedException('Origin not allowed');
      }
    }

    const secret = process.env.PAYSTACK_SECRET_KEY ?? '';
    // The Better Auth module attaches the unparsed body to req.rawBody
    // (bodyParser.rawBody:true). Fall back to a re-stringified body just in case.
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const raw: Buffer = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(JSON.stringify(req.body ?? {}));

    const expected = createHmac('sha512', secret).update(raw).digest('hex');
    const provided = signature ?? '';
    const valid =
      expected.length === provided.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
    if (!valid) {
      this.logger.warn('Rejected Paystack webhook: bad signature');
      throw new UnauthorizedException('Invalid signature');
    }

    let event: any;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid webhook payload');
    }

    // Persist (replayable log + dedup) and dispatch idempotently. charge.success/
    // failed reconcile the payment; disputes/refunds are logged + escalated.
    return this.enrollment.processPaystackWebhookEvent(event);
  }

  /**
   * Verify-on-return. The frontend calls this after the popup closes so the UI
   * can confirm immediately without waiting for the webhook. Idempotent.
   */
  @Get('verify')
  @Roles(UserRole.PARENT, UserRole.SCHOOL_OWNER)
  async verify(@Query('reference') reference: string, @CurrentUser() _user: any) {
    if (!reference) throw new BadRequestException('reference is required');
    const result = await this.paystack.verifyTransaction(reference);
    if (result.status === 'success') {
      await this.enrollment.reconcilePaystackPayment(
        reference,
        result.fees,
        null,
      );
      return { status: 'success', reference };
    }
    if (result.status === 'failed') {
      await this.enrollment.failPaystackPayment(reference);
      return { status: 'failed', reference };
    }
    return { status: result.status, reference };
  }
}
