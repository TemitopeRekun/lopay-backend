import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint (Milestone 5 — observability). Public and mounted
 * OUTSIDE the /api/v1 prefix (see the `exclude` list in main.ts), so a scraper
 * hits `GET /metrics`. Excluded from the OpenAPI spec — it is infra, not part of
 * the app API contract.
 */
@ApiExcludeController()
@Controller('metrics')
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
