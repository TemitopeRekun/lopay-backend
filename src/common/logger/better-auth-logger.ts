import { Logger } from '@nestjs/common';
import { redactFields, redactText } from './redact';

/**
 * Bridge from Better Auth's logger interface to the Nest logger, scrubbing PII on
 * the way through.
 *
 * ## Why this exists
 *
 * Better Auth writes its own diagnostics straight to the console, and some of them
 * carry the caller's email verbatim. A failed sign-in on the live deploy produces:
 *
 *     ERROR [Better Auth]: User not found { email: 'ada@example.com' }
 *
 * Two problems. The address is in the clear, in a log stream that anyone with
 * dashboard access can read and that Sentry may ingest — the exact leak `redact.ts`
 * exists to prevent, arriving through a door that module could not reach. And it is
 * logged at ERROR, so the single most common *expected* outcome on the auth surface
 * (someone mistyped their password) buries real faults in noise.
 *
 * Routing Better Auth's logger through Nest fixes both: every string and every
 * structured argument is scrubbed, and the output lands in `JsonLogger` like the rest
 * of the service instead of bypassing it as raw console writes.
 *
 * ## What is deliberately not done
 *
 * The ERROR level is preserved rather than downgraded. It is tempting to demote
 * "User not found" to debug, but the mapping from message text to severity belongs
 * to the library, and pattern-matching its strings would silently break on upgrade —
 * a filter that stops matching fails by *hiding* what it was meant to reclassify.
 * The noise is a level concern for the log sink; the leak is the part that needed
 * code.
 */

/** Better Auth's `Logger` levels (its own `success` is mapped onto `log`). */
export type BetterAuthLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The subset of Better Auth's `Logger` option this bridge implements. */
export interface BetterAuthLoggerAdapter {
  level: BetterAuthLogLevel;
  disableColors: boolean;
  log: (level: BetterAuthLogLevel, message: string, ...args: unknown[]) => void;
}

/**
 * Scrub one logger argument.
 *
 * Strings get the free-text email sweep. Plain objects — how Better Auth attaches
 * `{ email }`, `{ provider }` and friends — go through `redactFields`, which masks
 * contact details and drops secrets by key. Errors are reduced to name + scrubbed
 * message: an `Error` argument would otherwise serialise its stack, which for an
 * auth failure routinely quotes the offending input. Anything else (numbers,
 * booleans, null) is already safe to pass through.
 */
export function scrubLogArg(arg: unknown): unknown {
  if (typeof arg === 'string') return redactText(arg);
  if (arg instanceof Error) {
    return { name: arg.name, message: redactText(arg.message) };
  }
  if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
    return redactFields(arg as Record<string, unknown>);
  }
  return arg;
}

/**
 * Build the adapter to hand to `betterAuth({ logger })`.
 *
 * `level: 'warn'` matches Better Auth's own default. It is tempting to open this to
 * `debug` on the theory that the Nest logger will filter — but `JsonLogger` writes
 * every severity it is handed, so that would ship the library's full debug stream to
 * Render's log pipeline on every request. Nothing is lost by filtering here: Better
 * Auth applies the level BEFORE calling this adapter, and the leak this exists to
 * stop (the caller's email on a failed sign-in) is logged at `error`, which passes.
 *
 * `disableColors` because these lines are consumed as JSON, where ANSI escapes are
 * corruption rather than colour.
 */
export function createBetterAuthLogger(
  logger: Logger = new Logger('BetterAuth'),
): BetterAuthLoggerAdapter {
  return {
    level: 'warn',
    disableColors: true,
    log: (level, message, ...args) => {
      const safeMessage = redactText(message);
      const safeArgs = args.map(scrubLogArg);
      const payload =
        safeArgs.length > 0
          ? { message: safeMessage, details: safeArgs }
          : { message: safeMessage };

      switch (level) {
        case 'error':
          logger.error(payload);
          return;
        case 'warn':
          logger.warn(payload);
          return;
        case 'debug':
          logger.debug(payload);
          return;
        default:
          logger.log(payload);
      }
    },
  };
}
