import {
  RequestIdMiddleware,
  REQUEST_ID_HEADER,
} from './request-id.middleware';

describe('RequestIdMiddleware', () => {
  const header = REQUEST_ID_HEADER.toLowerCase();
  const mw = new RequestIdMiddleware();

  it('generates a request id when the inbound header is absent', () => {
    const req = { headers: {} as Record<string, string> };
    const setHeader = jest.fn();
    const next = jest.fn();

    mw.use(req as never, { setHeader } as never, next);

    const id = req.headers[header];
    expect(id).toBeDefined();
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, id);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('preserves a caller-supplied request id', () => {
    const req = { headers: { [header]: 'caller-123' } };
    const setHeader = jest.fn();
    const next = jest.fn();

    mw.use(req as never, { setHeader } as never, next);

    expect(req.headers[header]).toBe('caller-123');
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, 'caller-123');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
