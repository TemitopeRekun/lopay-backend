import { errorMessage, errorCode } from './errors';

describe('errorMessage', () => {
  it('reads .message off an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns a string error as-is', () => {
    expect(errorMessage('plain string')).toBe('plain string');
  });

  it('reads .message off a plain object with a string message', () => {
    expect(errorMessage({ message: 'object message' })).toBe('object message');
  });

  it('falls back for null / non-message values', () => {
    expect(errorMessage(null)).toBe('Unknown error');
    expect(errorMessage(42)).toBe('Unknown error');
    expect(errorMessage({ message: 123 })).toBe('Unknown error');
    expect(errorMessage(undefined, 'custom fallback')).toBe('custom fallback');
  });
});

describe('errorCode', () => {
  it('reads a string .code', () => {
    expect(errorCode({ code: 'P2002' })).toBe('P2002');
  });

  it('returns undefined when there is no string code', () => {
    expect(errorCode(new Error('x'))).toBeUndefined();
    expect(errorCode({ code: 123 })).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });
});
