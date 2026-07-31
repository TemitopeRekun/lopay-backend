import { Logger } from '@nestjs/common';
import { AUTH_EVENTS, logAuthEvent } from './auth-events';

function makeLogger() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger & {
    log: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };
}

describe('logAuthEvent', () => {
  it('routes a success to log level', () => {
    const logger = makeLogger();
    logAuthEvent(logger, AUTH_EVENTS.SIGNUP_SUCCEEDED, 'succeeded', {
      email: 'ada@gmail.com',
    });

    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  // A rejection is the system working as designed, not a fault — but it is the
  // thing you want to see when scanning, hence warn rather than log.
  it('routes a rejection to warn, not error', () => {
    const logger = makeLogger();
    logAuthEvent(logger, AUTH_EVENTS.SIGNUP_REJECTED, 'rejected', {
      reason: 'PHONE_ALREADY_REGISTERED',
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('routes a genuine failure to error', () => {
    const logger = makeLogger();
    logAuthEvent(logger, AUTH_EVENTS.SIGNUP_REJECTED, 'failed', {
      reason: 'DB_DOWN',
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('emits a flat object so JsonLogger keeps the line machine-parseable', () => {
    const logger = makeLogger();
    logAuthEvent(logger, AUTH_EVENTS.SIGNUP_REJECTED, 'rejected', {
      reason: 'NAME_REQUIRED',
      field: 'fullName',
      requestId: 'req-1',
    });

    const [entry] = logger.warn.mock.calls[0] as [Record<string, unknown>];
    expect(entry).toEqual({
      event: 'signup.rejected',
      outcome: 'rejected',
      reason: 'NAME_REQUIRED',
      field: 'fullName',
      requestId: 'req-1',
    });
  });

  // The whole point of routing events through here: PII cannot reach the log
  // sink even if a caller passes a raw value.
  it('redacts contact details before they reach the logger', () => {
    const logger = makeLogger();
    logAuthEvent(logger, AUTH_EVENTS.SIGNUP_REJECTED, 'rejected', {
      reason: 'PHONE_ALREADY_REGISTERED',
      email: 'ada.lovelace@gmail.com',
      phoneNumber: '08012345678',
      password: 'hunter2',
    });

    const [entry] = logger.warn.mock.calls[0] as [Record<string, unknown>];
    expect(entry.email).toBe('a***e@gmail.com');
    expect(entry.phoneNumber).toBe('***5678');
    expect(entry.password).toBe('[redacted]');
    expect(JSON.stringify(entry)).not.toContain('lovelace');
    expect(JSON.stringify(entry)).not.toContain('hunter2');
    expect(JSON.stringify(entry)).not.toContain('8012345678');
  });

  it('works with no fields at all', () => {
    const logger = makeLogger();
    logAuthEvent(logger, AUTH_EVENTS.SIGNUP_SUCCEEDED, 'succeeded');
    const [entry] = logger.log.mock.calls[0] as [Record<string, unknown>];
    expect(entry).toEqual({
      event: 'signup.succeeded',
      outcome: 'succeeded',
    });
  });
});
