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

  const run = (
    statusCode: number,
    headers: Record<string, string> = {},
    reqExtra: Record<string, unknown> = {},
  ) => {
    const req = { method: 'GET', originalUrl: '/x', headers, ...reqExtra };
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

  // `clientIp` is what makes CLIENT_IP_HEADER verifiable after a deploy: rate-limit
  // response headers look identical whether the app is keying on the real caller or
  // on its own edge, and getting that wrong is what put the entire service in one
  // 20-per-minute bucket. One constant address across every request means the header
  // is unset or wrong.
  describe('clientIp', () => {
    const withEnv = (env: Record<string, string | undefined>) => {
      const previous = { ...process.env };
      Object.assign(process.env, env);
      // Constructed AFTER the env is set: the header name is process-lifetime
      // configuration, read once in the constructor.
      const middleware = new RequestLoggerMiddleware();
      return {
        middleware,
        restore: () => {
          process.env = previous;
        },
      };
    };

    const logFor = (
      middleware: RequestLoggerMiddleware,
      headers: Record<string, string>,
      reqExtra: Record<string, unknown>,
    ) => {
      const req = { method: 'GET', originalUrl: '/x', headers, ...reqExtra };
      let finish = () => {};
      const res = {
        statusCode: 200,
        on: (evt: string, cb: () => void) => {
          if (evt === 'finish') finish = cb;
        },
      };
      middleware.use(req as never, res as never, jest.fn());
      finish();
      return logSpy.mock.calls[0][0];
    };

    it('reports the declared header when one is configured', () => {
      const { middleware, restore } = withEnv({
        CLIENT_IP_HEADER: 'cf-connecting-ip',
      });
      try {
        const entry = logFor(
          middleware,
          { 'cf-connecting-ip': '203.0.113.7' },
          { ip: '10.0.0.1' },
        );
        expect(entry.clientIp).toBe('203.0.113.7');
      } finally {
        restore();
      }
    });

    it('reports the socket address when no header is declared', () => {
      const { middleware, restore } = withEnv({ CLIENT_IP_HEADER: undefined });
      try {
        const entry = logFor(
          middleware,
          { 'x-forwarded-for': '1.2.3.4' },
          { ip: '10.0.0.1' },
        );
        // Not 1.2.3.4: an undeclared forwarded header is caller-controlled, so it is
        // ignored here exactly as the limiter ignores it.
        expect(entry.clientIp).toBe('10.0.0.1');
      } finally {
        restore();
      }
    });

    it('reports null when the caller cannot be established', () => {
      run(200);
      expect(logSpy.mock.calls[0][0].clientIp).toBeNull();
    });
  });
});
