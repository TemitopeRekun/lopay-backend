import { Controller, Get, Header, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';
import { MetricsService } from './metrics.service';
import { MetricsAuthGuard } from './metrics.guard';

/**
 * Prometheus scrape endpoint (Milestone 5 — observability). Mounted OUTSIDE the
 * /api/v1 prefix (see the `exclude` list in main.ts), so a scraper hits
 * `GET /metrics`. Excluded from the OpenAPI spec — it is infra, not part of the
 * app API contract.
 *
 * `@Public()` only means "no user session" — a scraper has none. Access is
 * controlled by `MetricsAuthGuard` (shared token, closed by default in
 * production); without it this endpoint published the platform's payment volume
 * to anyone who asked.
 */
@ApiExcludeController()
@Controller('metrics')
@UseGuards(MetricsAuthGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.render();
  }
}
