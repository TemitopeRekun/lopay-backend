import { Logger } from '@nestjs/common';
import { RequestLoggerMiddleware } from './request-logger.middleware';
import { REQUEST_ID_HEADER } from './request-id.middleware';

describe('RequestLoggerMiddleware', () => {
  const header = REQUEST_ID_HEADER.toLowerCase();
  let mw: RequestLoggerMiddleware;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mw = new RequestLoggerMiddleware();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  const run = (statusCode: number, headers: Record<string, string> = {}) => {
    const req = { method: 'GET', originalUrl: '/x', headers };
    let finish = () => {};
    const res = {
      statusCode,
      on: (evt: string, cb: () => void) => {
        if (evt === 'finish') finish = cb;
      },
    };
    const next = jest.fn();
    mw.use(req as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    finish();
  };

  it('logs a 2xx response at log level (with request id)', () => {
    run(200, { [header]: 'req-1' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('req-1');
  });

  it('logs a 4xx response at warn level', () => {
    run(404);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // no request id → placeholder dash
    expect(warnSpy.mock.calls[0][0]).toContain('[-]');
  });

  it('logs a 5xx response at error level', () => {
    run(500);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
