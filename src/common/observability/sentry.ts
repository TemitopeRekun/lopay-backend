import * as Sentry from '@sentry/node';

let enabled = false;

/**
 * Initialise Sentry error tracking IF a DSN is configured. No-op otherwise, so
 * local/dev and any deploy without a DSN behave exactly as before. Call once at
 * bootstrap, before the app handles traffic.
 */
export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
  });
  enabled = true;
  return true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

/** Report an exception to Sentry (no-op when disabled). */
export function captureException(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (!enabled) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
