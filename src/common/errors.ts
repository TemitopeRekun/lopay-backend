/**
 * Narrow an unknown caught value to a human-readable message.
 *
 * With `strict` (and `useUnknownInCatchVariables`) on, `catch` bindings are
 * `unknown` — code can no longer read `.message` directly. This is the single
 * place that does the narrowing, so call sites stay one-liners.
 */
export function errorMessage(
  error: unknown,
  fallback = 'Unknown error',
): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return fallback;
}

/** Read a `.code` string off an unknown error (e.g. provider/SDK error codes). */
export function errorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}
