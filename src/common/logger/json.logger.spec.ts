import { JsonLogger } from './json.logger';

describe('JsonLogger', () => {
  let writes: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    writes = [];
    spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(chunk.toString());
        return true;
      });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  function lastEntry(): Record<string, unknown> {
    return JSON.parse(writes[writes.length - 1]) as Record<string, unknown>;
  }

  it('emits a single-line JSON object with the expected shape', () => {
    new JsonLogger('TestCtx').log('hello');
    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith('\n')).toBe(true);
    const entry = lastEntry();
    expect(entry.message).toBe('hello');
    expect(entry.context).toBe('TestCtx');
    expect(typeof entry.timestamp).toBe('string');
  });

  it('defaults the context to "app" when none is set', () => {
    new JsonLogger().log('x');
    expect(lastEntry().context).toBe('app');
  });

  it('honours setContext', () => {
    const logger = new JsonLogger();
    logger.setContext('Later');
    logger.warn('w');
    expect(lastEntry().context).toBe('Later');
  });

  it.each([
    ['log', 'debug'],
    ['error', 'error'],
    ['warn', 'warn'],
    ['debug', 'info'],
    ['verbose', 'debug'],
    ['fatal', 'error'],
  ] as const)('maps %s() to level %s', (method, level) => {
    const logger = new JsonLogger();
    (logger[method] as (m: unknown) => void)('msg');
    expect(lastEntry().level).toBe(level);
  });

  it('stringifies a non-string message', () => {
    new JsonLogger().log({ a: 1 });
    expect(lastEntry().message).toBe(JSON.stringify({ a: 1 }));
  });

  it('attaches a single object param as structured meta', () => {
    new JsonLogger().log('m', { requestId: 'r1' });
    expect(lastEntry().meta).toEqual({ requestId: 'r1' });
  });

  it('attaches a single primitive param as a string meta', () => {
    new JsonLogger().log('m', 42);
    expect(lastEntry().meta).toBe('42');
  });

  it('attaches multiple params as an array meta', () => {
    new JsonLogger().log('m', 'a', { b: 2 }, 3);
    expect(lastEntry().meta).toEqual(['a', JSON.stringify({ b: 2 }), '3']);
  });

  it('falls back gracefully when the message cannot be JSON-stringified', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    new JsonLogger().log(circular);
    // Should not throw; message is the toString fallback.
    expect(lastEntry().message).toBe('[object Object]');
  });
});
