import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { GlobalExceptionFilter } from './http-exception.filter';
import { REQUEST_ID_HEADER } from '../middleware/request-id.middleware';
import * as sentry from '../observability/sentry';

jest.mock('../observability/sentry', () => ({
  captureException: jest.fn(),
}));

describe('GlobalExceptionFilter', () => {
  const filter = new GlobalExceptionFilter();
  const header = REQUEST_ID_HEADER.toLowerCase();

  const build = (headers: Record<string, string> = {}) => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const req = { method: 'GET', url: '/thing', headers };
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => req,
      }),
    };
    return { host, status, json };
  };

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('maps an HttpException with a string body to its status + message', () => {
    const { host, status, json } = build({ [header]: 'r1' });
    filter.catch(
      new HttpException('plain message', HttpStatus.BAD_REQUEST),
      host as never,
    );
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'plain message',
        requestId: 'r1',
        path: '/thing',
      }),
    );
  });

  it('extracts message from an HttpException object body', () => {
    const { host, json } = build();
    filter.catch(
      new HttpException(
        { message: ['a', 'b'] },
        HttpStatus.UNPROCESSABLE_ENTITY,
      ),
      host as never,
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: ['a', 'b'], requestId: null }),
    );
  });

  it('falls back to a generic message when the object body has no message', () => {
    const { host, json } = build();
    filter.catch(
      new HttpException({ foo: 'bar' }, HttpStatus.BAD_REQUEST),
      host as never,
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'An error occurred' }),
    );
  });

  it('treats an unknown error as a 500, logs it and reports to Sentry', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { host, status, json } = build({ [header]: 'r5' });
    filter.catch(new Error('boom'), host as never);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Internal server error' }),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        method: 'GET',
        path: '/thing',
        requestId: 'r5',
      }),
    );
  });

  it('reports a non-Error thrown value to Sentry as a 500', () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { host, status } = build();
    filter.catch('just a string', host as never);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
