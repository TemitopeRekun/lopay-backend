/**
 * Resolving the true client IP behind a reverse proxy, for rate-limit keying.
 *
 * ## The bug this exists to fix
 *
 * The auth brute-force limiter in `app.module.ts` keys on `req.ip`. On Render
 * nothing sets Express's `trust proxy`, so `req.ip` is the address of the *edge*
 * that terminates TLS, not the caller — identical for every human on the internet.
 * Measured against the live deploy: four requests carrying two different
 * `X-Forwarded-For` values all decremented one shared counter. So the limit was
 * one bucket for the entire service, and since the SPA calls `/api/auth/get-session`
 * on every page load, ordinary traffic exhausted it — while an attacker needed only
 * the same handful of requests per minute to lock every parent out of signing in.
 * A limiter that cannot tell two clients apart is not a brute-force control; it is
 * a denial-of-service amplifier.
 *
 * ## Why an explicit header name, not a hop count
 *
 * The obvious repair — `app.set('trust proxy', 1)` — trades one silent failure for
 * a worse one. A numeric hop count makes Express walk `X-Forwarded-For` from the
 * right, so the correct value depends on how many proxies actually sit in front of
 * the app. Guess too high and you start reading a client-supplied entry: the
 * limiter becomes trivially bypassable by sending `X-Forwarded-For: <random>` on
 * every attempt, which is strictly worse than today, because today's shared bucket
 * at least cannot be evaded. Render fronts services with its own edge and reports
 * `Server: cloudflare`, so the depth is a deployment property this code cannot
 * observe.
 *
 * So the topology is declared, not inferred. `CLIENT_IP_HEADER` names the ONE
 * header the operator has verified their edge *overwrites* (`cf-connecting-ip` on a
 * Cloudflare-fronted host; `x-forwarded-for` only where the edge is known to
 * replace rather than append). Unset — the safe default, and what a directly
 * exposed deploy wants — falls back to the socket address, i.e. exactly today's
 * behaviour. Nothing is trusted until someone says so.
 *
 * To confirm a candidate header before setting it, `RequestLoggerMiddleware` logs
 * the resolved `clientIp` on every request: if it shows real, varying public
 * addresses, the header is right; if it shows one constant address, it is not.
 */

/** Minimal shape of the request this module reads — keeps it Express-agnostic. */
export interface ClientIpRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

/**
 * Private header this app stamps the resolved client IP onto, for Better Auth to
 * read.
 *
 * Better Auth is framework-agnostic: it sees a web `Request`, never a socket, so
 * `getIp` can only read headers. Left to its own devices it defaults to
 * `["x-forwarded-for"]` and takes the LEFTMOST entry — which is the value the
 * caller sent, since an edge appends rather than replaces. Its rate limiter would
 * therefore key on a number the attacker chooses, and a fresh
 * `X-Forwarded-For: <random>` per request buys unlimited password guesses.
 *
 * Pointing `advanced.ipAddress.ipAddressHeaders` at this header instead gives both
 * limiters one source of truth — this module — and makes the value unforgeable,
 * because `stampClientIp` overwrites whatever arrived before Better Auth ever sees
 * the request.
 */
export const RESOLVED_CLIENT_IP_HEADER = 'x-lopay-client-ip';

/**
 * Bucket for a request whose caller cannot be established.
 *
 * A valid IPv4 literal rather than a word, because Better Auth discards anything
 * `isValidIP` rejects and then SKIPS rate limiting altogether. Unattributable
 * requests must still share one bucket (fail closed), not slip past uncounted.
 */
export const UNKNOWN_CLIENT_IP = '0.0.0.0';

/**
 * Write the resolved client IP onto the request for Better Auth to read.
 *
 * Assignment, not a conditional — overwriting unconditionally is the security
 * property. If a caller could supply `x-lopay-client-ip` and have it survive, this
 * header would be exactly as forgeable as the `x-forwarded-for` it replaces.
 */
export function stampClientIp(
  req: ClientIpRequest,
  headerName: string | null,
): string {
  const resolved = resolveClientIp(req, headerName) ?? UNKNOWN_CLIENT_IP;
  req.headers[RESOLVED_CLIENT_IP_HEADER] = resolved;
  return resolved;
}

/**
 * First entry of a forwarded-for style header value.
 *
 * `X-Forwarded-For` is an append-ordered list, `client, proxy1, proxy2`, so the
 * leftmost entry is the original caller — trustworthy ONLY because the caller had
 * to name this header via `CLIENT_IP_HEADER` (see the module docblock). A repeated
 * header arrives as an array; take the first occurrence for the same reason.
 */
export function parseForwardedIp(
  raw: string | string[] | undefined,
): string | null {
  if (raw === undefined) return null;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') return null;
  const candidate = first.split(',')[0]?.trim();
  return candidate ? normalizeIp(candidate) : null;
}

/**
 * Strip the decorations that stop two spellings of one address from sharing a
 * rate-limit bucket.
 *
 * - `::ffff:1.2.3.4` → `1.2.3.4`: Node reports IPv4 peers in IPv4-mapped IPv6 form
 *   on a dual-stack socket, so the same client would otherwise key differently
 *   depending on which listener accepted it.
 * - `[2001:db8::1]:443` → `2001:db8::1` and `1.2.3.4:5678` → `1.2.3.4`: the source
 *   port changes on every connection, so leaving it on would give each *request* a
 *   private bucket and defeat the limiter entirely.
 */
export function normalizeIp(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  // Bracketed IPv6, optionally with a port: [::1]:443
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1]) value = bracketed[1];

  // IPv4 with a port. Guarded on a single colon so IPv6 is never truncated.
  const colonCount = (value.match(/:/g) ?? []).length;
  if (colonCount === 1 && value.includes('.')) {
    value = value.slice(0, value.indexOf(':'));
  }

  // IPv4-mapped IPv6.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped?.[1]) value = mapped[1];

  // Drop any IPv6 zone index (fe80::1%eth0) — same interface, same client.
  const percent = value.indexOf('%');
  if (percent !== -1) value = value.slice(0, percent);

  return value || null;
}

/**
 * Collapse an IPv6 address to its /64 prefix so one subscriber is one bucket.
 *
 * A residential or mobile IPv6 client is routinely handed a whole /64 and can pick
 * a fresh address inside it per request. Keying on the full 128 bits would let an
 * attacker walk that space and get an unlimited number of sign-in attempts, which
 * is the exact evasion the limiter exists to prevent. IPv4 is returned untouched.
 *
 * Matches Better Auth's own default (`advanced.ipAddress.ipv6Subnet`, /64) so the
 * two limiters bucket the same caller identically.
 */
export function collapseIpv6(ip: string, prefixBits = 64): string {
  if (!ip.includes(':')) return ip;
  // Expand `::` so the leading groups can be counted positionally.
  const [head = '', tail = ''] = ip.split('::', 2);
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = ip.includes('::')
    ? [
        ...headGroups,
        ...Array<string>(Math.max(missing, 0)).fill('0'),
        ...tailGroups,
      ]
    : ip.split(':');
  if (groups.length !== 8) return ip;

  const keep = Math.max(0, Math.min(8, Math.floor(prefixBits / 16)));
  const masked = groups
    .slice(0, keep)
    .concat(Array<string>(8 - keep).fill('0'))
    .map((g) => (g === '' ? '0' : g.toLowerCase()));
  return masked.join(':');
}

/**
 * The caller's IP, or `null` when it cannot be established.
 *
 * `null` is meaningful: the limiter turns it into a single shared bucket, which
 * fails *closed* (everyone throttled together) rather than open (nobody
 * throttled). That only happens for a request with no socket and no declared
 * header, i.e. never in practice.
 */
export function resolveClientIp(
  req: ClientIpRequest,
  headerName: string | null,
): string | null {
  if (headerName) {
    const fromHeader = parseForwardedIp(req.headers[headerName]);
    if (fromHeader) return fromHeader;
  }
  const direct = req.ip ?? req.socket?.remoteAddress;
  return direct ? normalizeIp(direct) : null;
}

/**
 * The rate-limit bucket key for a request: the client IP, normalized and — for
 * IPv6 — collapsed to its /64.
 *
 * `unknown` is the deliberate shared-bucket fallback described above; it is a
 * fixed string rather than a random one so unattributable requests throttle
 * together instead of each getting a free pass.
 */
export function clientIpKey(
  req: ClientIpRequest,
  headerName: string | null,
): string {
  const ip = resolveClientIp(req, headerName);
  return ip ? collapseIpv6(ip) : 'unknown';
}
