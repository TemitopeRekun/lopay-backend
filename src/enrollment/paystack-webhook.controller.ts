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
    const secret = process.env.PAYSTACK_SECRET_KEY ?? '';
    // req.body is a Buffer here because bodyParser.raw is mounted on this path.
    const raw: Buffer = Buffer.isBuffer(req.body)
      ? req.body
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

    const reference: string | undefined = event?.data?.reference;
    if (!reference) return { received: true };

    // Process known events; everything else is acknowledged and ignored.
    if (event.event === 'charge.success') {
      const fees = typeof event.data.fees === 'number' ? event.data.fees : null;
      await this.enrollment.reconcilePaystackPayment(reference, fees, null);
    } else if (event.event === 'charge.failed') {
      await this.enrollment.failPaystackPayment(reference);
    }

    return { received: true };
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
