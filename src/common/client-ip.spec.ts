import {
  RESOLVED_CLIENT_IP_HEADER,
  UNKNOWN_CLIENT_IP,
  clientIpKey,
  collapseIpv6,
  normalizeIp,
  parseForwardedIp,
  resolveClientIp,
  stampClientIp,
  type ClientIpRequest,
} from './client-ip';

const req = (
  headers: Record<string, string | string[] | undefined>,
  extra: Partial<ClientIpRequest> = {},
): ClientIpRequest => ({ headers, ...extra });

describe('parseForwardedIp', () => {
  it('takes the leftmost entry of an append-ordered list', () => {
    expect(parseForwardedIp('203.0.113.7, 70.41.3.18, 150.172.238.178')).toBe(
      '203.0.113.7',
    );
  });

  it('handles a single value', () => {
    expect(parseForwardedIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('takes the first occurrence when the header is repeated', () => {
    expect(parseForwardedIp(['203.0.113.7', '198.51.100.2'])).toBe(
      '203.0.113.7',
    );
  });

  it.each([undefined, '', '   ', ','])('returns null for %p', (raw) => {
    expect(parseForwardedIp(raw)).toBeNull();
  });
});

describe('normalizeIp', () => {
  // Node reports IPv4 peers in mapped form on a dual-stack socket. Without this the
  // same client keys differently depending on which listener accepted it.
  it('unwraps an IPv4-mapped IPv6 address', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  // The source port changes on every connection, so leaving it attached would hand
  // each request its own bucket and neuter the limiter completely.
  it('strips the port from an IPv4 address', () => {
    expect(normalizeIp('203.0.113.7:54321')).toBe('203.0.113.7');
  });

  it('strips the port from a bracketed IPv6 address', () => {
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
  });

  it('unbrackets an IPv6 address with no port', () => {
    expect(normalizeIp('[2001:db8::1]')).toBe('2001:db8::1');
  });

  // The colon guard must not truncate a bare IPv6 address, which is all colons.
  it('leaves a bare IPv6 address intact', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('drops an IPv6 zone index', () => {
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it.each(['', '   '])('returns null for %p', (raw) => {
    expect(normalizeIp(raw)).toBeNull();
  });
});

describe('collapseIpv6', () => {
  // A mobile or residential IPv6 client owns a whole /64 and can pick a fresh
  // address per request. Keying on all 128 bits would give an attacker unlimited
  // sign-in attempts simply by walking their own subnet.
  it('collapses addresses in one /64 to a single key', () => {
    expect(collapseIpv6('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(
      collapseIpv6('2001:db8:1:2:1111:2222:3333:4444'),
    );
  });

  it('keeps distinct /64s distinct', () => {
    expect(collapseIpv6('2001:db8:1:2::1')).not.toBe(
      collapseIpv6('2001:db8:1:3::1'),
    );
  });

  it('expands :: before masking', () => {
    expect(collapseIpv6('2001:db8::1')).toBe('2001:db8:0:0:0:0:0:0');
  });

  it('handles a leading ::', () => {
    expect(collapseIpv6('::1')).toBe('0:0:0:0:0:0:0:0');
  });

  it('leaves IPv4 untouched', () => {
    expect(collapseIpv6('203.0.113.7')).toBe('203.0.113.7');
  });

  it('is case-insensitive so one address yields one key', () => {
    expect(collapseIpv6('2001:DB8:1:2::1')).toBe(
      collapseIpv6('2001:db8:1:2::1'),
    );
  });

  it('returns the input unchanged when it is not a parseable IPv6 address', () => {
    expect(collapseIpv6('2001:db8:1')).toBe('2001:db8:1');
  });

  it('honours a custom prefix length', () => {
    expect(collapseIpv6('2001:db8:1:2::1', 32)).toBe('2001:db8:0:0:0:0:0:0');
  });
});

describe('resolveClientIp', () => {
  it('reads the declared header when present', () => {
    expect(
      resolveClientIp(
        req({ 'cf-connecting-ip': '203.0.113.7' }),
        'cf-connecting-ip',
      ),
    ).toBe('203.0.113.7');
  });

  // This is the whole point of the module: with no header declared, a header the
  // caller supplies is ignored outright rather than trusted. An attacker cannot opt
  // into a private bucket.
  it('ignores forwarded headers when none is declared', () => {
    expect(
      resolveClientIp(
        req(
          { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' },
          { ip: '10.0.0.1' },
        ),
        null,
      ),
    ).toBe('10.0.0.1');
  });

  it('ignores headers other than the declared one', () => {
    expect(
      resolveClientIp(
        req({ 'x-forwarded-for': '1.2.3.4' }, { ip: '10.0.0.1' }),
        'cf-connecting-ip',
      ),
    ).toBe('10.0.0.1');
  });

  it('falls back to the socket address when the declared header is absent', () => {
    expect(
      resolveClientIp(
        req({}, { socket: { remoteAddress: '::ffff:203.0.113.9' } }),
        'cf-connecting-ip',
      ),
    ).toBe('203.0.113.9');
  });

  it('prefers req.ip over the raw socket address', () => {
    expect(
      resolveClientIp(
        req({}, { ip: '203.0.113.1', socket: { remoteAddress: '10.0.0.1' } }),
        null,
      ),
    ).toBe('203.0.113.1');
  });

  it('returns null when the caller cannot be established at all', () => {
    expect(resolveClientIp(req({}), null)).toBeNull();
  });
});

describe('clientIpKey', () => {
  it('gives two different callers two different buckets', () => {
    const header = 'cf-connecting-ip';
    expect(clientIpKey(req({ [header]: '203.0.113.7' }), header)).not.toBe(
      clientIpKey(req({ [header]: '198.51.100.4' }), header),
    );
  });

  // The regression that motivated all of this: behind an edge that sets no declared
  // header, every caller collapses onto one key — which is what turned a 20/min
  // brute-force limit into a 20/min limit for the entire service.
  it('collapses all callers onto one bucket when no header is declared', () => {
    const a = clientIpKey(
      req({ 'x-forwarded-for': '1.1.1.1' }, { ip: '10.0.0.1' }),
      null,
    );
    const b = clientIpKey(
      req({ 'x-forwarded-for': '2.2.2.2' }, { ip: '10.0.0.1' }),
      null,
    );
    expect(a).toBe(b);
  });

  it('buckets an unattributable request under a fixed key rather than a free pass', () => {
    expect(clientIpKey(req({}), null)).toBe('unknown');
    // Two unattributable requests must share the bucket — a per-request key would
    // mean no limit at all for exactly the requests we know least about.
    expect(clientIpKey(req({}), null)).toBe(
      clientIpKey(req({}), 'cf-connecting-ip'),
    );
  });

  it('keys one IPv6 subscriber consistently across their /64', () => {
    const header = 'cf-connecting-ip';
    expect(clientIpKey(req({ [header]: '2001:db8:1:2:aaaa::1' }), header)).toBe(
      clientIpKey(req({ [header]: '2001:db8:1:2:ffff::9' }), header),
    );
  });
});

describe('stampClientIp', () => {
  it('writes the resolved IP where Better Auth will read it', () => {
    const request = req({ 'cf-connecting-ip': '203.0.113.7' });
    expect(stampClientIp(request, 'cf-connecting-ip')).toBe('203.0.113.7');
    expect(request.headers[RESOLVED_CLIENT_IP_HEADER]).toBe('203.0.113.7');
  });

  // The security property, found in self-review. Better Auth only sees headers, so
  // if a caller could supply this one and have it survive, its limiter would key on
  // a value the attacker picks — exactly the `x-forwarded-for` weakness this
  // replaces. Overwriting unconditionally is what makes the header trustworthy.
  it('overwrites a value supplied by the caller', () => {
    const request = req({
      [RESOLVED_CLIENT_IP_HEADER]: '9.9.9.9',
      'cf-connecting-ip': '203.0.113.7',
    });
    stampClientIp(request, 'cf-connecting-ip');
    expect(request.headers[RESOLVED_CLIENT_IP_HEADER]).toBe('203.0.113.7');
  });

  it('overwrites a spoofed value even when the caller cannot be identified', () => {
    const request = req({ [RESOLVED_CLIENT_IP_HEADER]: '9.9.9.9' });
    stampClientIp(request, null);
    expect(request.headers[RESOLVED_CLIENT_IP_HEADER]).toBe(UNKNOWN_CLIENT_IP);
  });

  it('falls back to the socket address with no header declared', () => {
    const request = req({ 'x-forwarded-for': '1.2.3.4' }, { ip: '10.0.0.1' });
    // Not 1.2.3.4: an undeclared forwarded header stays untrusted here too.
    expect(stampClientIp(request, null)).toBe('10.0.0.1');
  });

  // Better Auth discards anything isValidIP rejects and then SKIPS rate limiting
  // entirely, so the unknown bucket has to be a real IPv4 literal — a word like
  // "unknown" would let unattributable requests through uncounted.
  it('uses a valid IPv4 literal for the unknown bucket', () => {
    expect(UNKNOWN_CLIENT_IP).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    expect(stampClientIp(req({}), null)).toBe(UNKNOWN_CLIENT_IP);
  });
});
