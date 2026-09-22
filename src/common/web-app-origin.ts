/**
 * Where the web client lives, as far as the API is concerned.
 *
 * Two features need to build an absolute URL into the frontend: a web push
 * notification's click target, and an enrollment invite's claim link. They must
 * agree, and neither may quietly produce a broken one.
 *
 * `WEB_APP_URL` is optional in the Joi schema, so "unset" is a real state rather
 * than a misconfiguration to assume away. The fallback is the first
 * `CORS_ORIGINS` entry, which is the web client by definition — it is the origin
 * the browser talks to the API from. Whatever the source, the value is parsed
 * before use: an unparseable origin produces a link the browser refuses to open,
 * and it is better to know that here than to discover it from a parent who was
 * sent a dead link.
 *
 * The caller decides what an absent origin means. Push notifications degrade
 * (the notification still arrives, it just isn't clickable); an invite link
 * cannot degrade, because a relative path in a WhatsApp message is useless — so
 * `requireWebAppOrigin` exists to fail loudly for that case.
 */

export interface WebAppOriginEnv {
  get<T = string>(key: string): T | undefined;
}

/**
 * Resolve the web client's origin, or undefined when neither source yields a
 * parseable one. `onInvalid` is called with the offending value so the caller
 * can log it in its own logger rather than this module owning one.
 */
export function resolveWebAppOrigin(
  config: WebAppOriginEnv,
  onInvalid?: (candidate: string) => void,
): string | undefined {
  const explicit = config.get<string>('WEB_APP_URL')?.trim();
  const firstCorsOrigin = config
    .get<string>('CORS_ORIGINS')
    ?.split(',')[0]
    ?.trim();

  const candidate = explicit || firstCorsOrigin;
  if (!candidate) return undefined;

  try {
    return new URL(candidate).origin;
  } catch {
    onInvalid?.(candidate);
    return undefined;
  }
}

/**
 * The origin, or a thrown error naming the variable to set.
 *
 * Used where a relative fallback would ship something broken to a user. An
 * invite whose link is `/enrollment-invites/claim?token=…` looks fine in an API
 * response and is worthless in the WhatsApp message it ends up in, so this
 * refuses to mint one at all.
 */
export function requireWebAppOrigin(
  config: WebAppOriginEnv,
  onInvalid?: (candidate: string) => void,
): string {
  const origin = resolveWebAppOrigin(config, onInvalid);
  if (!origin) {
    throw new Error(
      'WEB_APP_URL (or a usable CORS_ORIGINS entry) must be set to build an invite link',
    );
  }
  return origin;
}
