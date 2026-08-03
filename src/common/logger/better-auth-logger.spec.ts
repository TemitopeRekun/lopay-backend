import { Logger } from '@nestjs/common';
import { createBetterAuthLogger, scrubLogArg } from './better-auth-logger';

describe('scrubLogArg', () => {
  it('masks an email inside a string', () => {
    expect(scrubLogArg('User not found: ada.lovelace@example.com')).toBe(
      'User not found: a***e@example.com',
    );
  });

  // This is the exact shape Better Auth uses — `logger.error('User not found', {
  // email })` — so it is the case that actually leaked on the live deploy.
  it('masks an email attached as a structured field', () => {
    expect(scrubLogArg({ email: 'ada.lovelace@example.com' })).toEqual({
      email: 'a***e@example.com',
    });
  });

  it('redacts secrets by key', () => {
    expect(scrubLogArg({ password: 'hunter2', token: 'abc' })).toEqual({
      password: '[redacted]',
      token: '[redacted]',
    });
  });

  it('passes non-sensitive fields through for diagnosis', () => {
    expect(scrubLogArg({ provider: 'google', attempt: 2 })).toEqual({
      provider: 'google',
      attempt: 2,
    });
  });

  // An Error argument would otherwise serialise its stack, and an auth failure's
  // stack routinely quotes the offending input.
  it('reduces an Error to name and scrubbed message, dropping the stack', () => {
    const err = new TypeError('bad address ada@example.com');
    expect(scrubLogArg(err)).toEqual({
      name: 'TypeError',
      message: 'bad address a***a@example.com',
    });
    expect(JSON.stringify(scrubLogArg(err))).not.toContain(
      'better-auth-logger',
    );
  });

  it.each([42, true, null, undefined])('leaves %p alone', (value) => {
    expect(scrubLogArg(value)).toBe(value);
  });

  it('leaves arrays alone rather than mangling them into an object', () => {
    expect(scrubLogArg(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('createBetterAuthLogger', () => {
  let logger: Logger;
  let spies: Record<'log' | 'warn' | 'error' | 'debug', jest.SpyInstance>;

  beforeEach(() => {
    logger = new Logger('test');
    spies = {
      log: jest.spyOn(logger, 'log').mockImplementation(),
      warn: jest.spyOn(logger, 'warn').mockImplementation(),
      error: jest.spyOn(logger, 'error').mockImplementation(),
      debug: jest.spyOn(logger, 'debug').mockImplementation(),
    };
  });

  afterEach(() => jest.restoreAllMocks());

  it('routes each level to the matching Nest logger method', () => {
    const adapter = createBetterAuthLogger(logger);
    adapter.log('error', 'boom');
    adapter.log('warn', 'careful');
    adapter.log('debug', 'noisy');
    adapter.log('info', 'fyi');

    expect(spies.error).toHaveBeenCalledWith({ message: 'boom' });
    expect(spies.warn).toHaveBeenCalledWith({ message: 'careful' });
    expect(spies.debug).toHaveBeenCalledWith({ message: 'noisy' });
    expect(spies.log).toHaveBeenCalledWith({ message: 'fyi' });
  });

  // The regression: `ERROR [Better Auth]: User not found { email: 'ada@…' }` put
  // plaintext parent emails into the Render log stream on every failed sign-in.
  it('scrubs the message and the attached fields', () => {
    createBetterAuthLogger(logger).log('error', 'User not found', {
      email: 'ada.lovelace@example.com',
    });

    expect(spies.error).toHaveBeenCalledWith({
      message: 'User not found',
      details: [{ email: 'a***e@example.com' }],
    });
  });

  it('scrubs an email embedded in the message itself', () => {
    createBetterAuthLogger(logger).log('error', 'no user for ada@example.com');
    expect(spies.error).toHaveBeenCalledWith({
      message: 'no user for a***a@example.com',
    });
  });

  it('omits the details key when there are no arguments', () => {
    createBetterAuthLogger(logger).log('info', 'plain');
    expect(spies.log).toHaveBeenCalledWith({ message: 'plain' });
  });

  it('keeps every argument, in order', () => {
    createBetterAuthLogger(logger).log('warn', 'two', { a: 1 }, { b: 2 });
    expect(spies.warn).toHaveBeenCalledWith({
      message: 'two',
      details: [{ a: 1 }, { b: 2 }],
    });
  });

  // Corrected in self-review. This was 'debug' on the theory that JsonLogger would
  // filter — it does not; it writes every severity handed to it, so 'debug' would
  // have shipped Better Auth's entire debug stream to Render on every request.
  // Nothing is lost: the library applies the level BEFORE calling this adapter, and
  // the leak this exists to stop is logged at error, which passes a 'warn' floor.
  it('matches the library default level and disables colours', () => {
    const adapter = createBetterAuthLogger(logger);
    expect(adapter.level).toBe('warn');
    expect(adapter.disableColors).toBe(true);
  });
});
