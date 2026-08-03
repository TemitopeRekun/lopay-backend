import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { REQUEST_ID_HEADER } from './request-id.middleware';
import { resolveClientIp } from '../client-ip';
import { resolveSecurityPosture } from '../security-posture';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  /**
   * Which header (if any) carries the true client IP. Read once at construction:
   * it is process-lifetime configuration, not per-request state.
   */
  private readonly clientIpHeader = resolveSecurityPosture(process.env)
    .clientIpHeader;

  use(req: Request, res: Response, next: NextFunction) {
    const { method, originalUrl } = req;
    const requestId = req.headers[REQUEST_ID_HEADER.toLowerCase()] as string;
    const start = Date.now();

    res.on('finish', () => {
      const { statusCode } = res;
      const duration = Date.now() - start;
      this.logger.log({
        method,
        url: originalUrl,
        status: statusCode,
        durationMs: duration,
        requestId: requestId ?? null,
        // The IP the rate limiters key on, resolved exactly as they resolve it.
        //
        // This is what makes CLIENT_IP_HEADER verifiable rather than hopeful: a
        // misconfigured deployment cannot be distinguished from a correct one by
        // watching rate-limit response headers, but it is obvious here. Varying
        // public addresses across callers means the header is right; one constant
        // address on every request means the app is keying on its own edge and the
        // entire service shares a single bucket — the bug this replaced.
        clientIp: resolveClientIp(req, this.clientIpHeader),
      });
    });

    next();
  }
}
