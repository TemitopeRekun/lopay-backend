import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import { resolveSecurityPosture } from '../security-posture';

/**
 * Access control for `GET /metrics`.
 *
 * The scrape endpoint is `@Public()` (a Prometheus scraper has no session), which
 * previously meant *anyone* could read it. It is not a money endpoint, but it does
 * publish payment volume, confirmation latency and stalled-confirmation counts —
 * i.e. the platform's transaction book at a glance — plus process internals.
 *
 * Policy:
 *   - `METRICS_TOKEN` set  -> require `Authorization: Bearer <token>` (or
 *     `X-Metrics-Token`). Wrong/missing token -> 401.
 *   - `METRICS_TOKEN` unset -> allowed on a non-TLS (local) deployment so `curl`
 *     and the tests keep working, and 404 on an internet-facing one, so a
 *     misconfigured deploy fails closed instead of advertising the endpoint.
 *
 * "Internet-facing" comes from `SecurityPosture.httpsDeployment`, NOT from
 * `NODE_ENV`. This deploy runs `NODE_ENV=development` on purpose (the config schema
 * demands live credentials once it is "production"), so a NODE_ENV check here would
 * have left the endpoint wide open on the very host that needed closing — the exact
 * failure `security-posture.ts` exists to prevent.
 *
 * The comparison hashes both sides first: `timingSafeEqual` throws on unequal
 * lengths, and comparing digests keeps the check constant-time without leaking the
 * configured token's length.
 */
@Injectable()
export class MetricsAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const configured = (process.env.METRICS_TOKEN ?? '').trim();

    if (!configured) {
      if (resolveSecurityPosture(process.env).httpsDeployment) {
        throw new NotFoundException();
      }
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ headers: IncomingHttpHeaders }>();
    const provided = MetricsAuthGuard.extractToken(request.headers);
    if (!provided || !MetricsAuthGuard.matches(provided, configured)) {
      throw new UnauthorizedException();
    }
    return true;
  }

  /** `Authorization: Bearer <token>`, falling back to `X-Metrics-Token`. */
  private static extractToken(headers: IncomingHttpHeaders): string | null {
    const authorization = headers.authorization;
    if (typeof authorization === 'string') {
      const [scheme, ...rest] = authorization.trim().split(/\s+/);
      if (scheme?.toLowerCase() === 'bearer' && rest.length > 0) {
        return rest.join(' ');
      }
    }
    const custom = headers['x-metrics-token'];
    const value = Array.isArray(custom) ? custom[0] : custom;
    return value ? value.trim() : null;
  }

  private static matches(provided: string, configured: string): boolean {
    const digest = (value: string) =>
      createHash('sha256').update(value, 'utf8').digest();
    return timingSafeEqual(digest(provided), digest(configured));
  }
}
