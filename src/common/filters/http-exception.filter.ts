import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '../middleware/request-id.middleware';
import { captureException } from '../observability/sentry';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = request.headers[REQUEST_ID_HEADER.toLowerCase()] as string;

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? (() => {
            const res = exception.getResponse();
            if (typeof res === 'string') return res;
            if (typeof res === 'object' && res !== null && 'message' in res) {
              return (res as { message: string | string[] }).message;
            }
            return 'An error occurred';
          })()
        : 'Internal server error';

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
        requestId,
      );
      // Report to Sentry when configured (no-op otherwise).
      captureException(exception, {
        method: request.method,
        path: request.url,
        requestId,
      });
    }

    response.status(status).json({
      statusCode: status,
      message,
      requestId: requestId ?? null,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
