import { Logger } from '@nestjs/common';
import { RequestLoggerMiddleware } from './request-logger.middleware';
import { REQUEST_ID_HEADER } from './request-id.middleware';

describe('RequestLoggerMiddleware', () => {
  const header = REQUEST_ID_HEADER.toLowerCase();
  let mw: RequestLoggerMiddleware;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    mw = new RequestLoggerMiddleware();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
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

  it('logs a 2xx response with JSON-structured entry (with request id)', () => {
    run(200, { [header]: 'req-1' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = logSpy.mock.calls[0][0];
    expect(entry).toBeDefined();
    expect(entry.method).toBe('GET');
    expect(entry.url).toBe('/x');
    expect(entry.status).toBe(200);
    expect(entry.requestId).toBe('req-1');
    expect(typeof entry.durationMs).toBe('number');
  });

  it('logs a 4xx response with null requestId when no header', () => {
    run(404);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = logSpy.mock.calls[0][0];
    expect(entry.status).toBe(404);
    expect(entry.requestId).toBeNull();
  });

  it('logs a 5xx response', () => {
    run(500);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = logSpy.mock.calls[0][0];
    expect(entry.status).toBe(500);
  });
});
