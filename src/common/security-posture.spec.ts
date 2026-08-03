import {
  STRICT_API_CSP,
  isHttpsUrl,
  parseBooleanEnv,
  resolveSecurityPosture,
} from './security-posture';

describe('parseBooleanEnv', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' true '])(
    'reads %p as enabled',
    (raw) => {
      expect(parseBooleanEnv(raw)).toBe(true);
    },
  );

  // The allowlist exists so that no value nobody meant as truthy can switch a
  // security control on. `ture` is the realistic typo; `0`/`false`/`off` are the
  // spellings an operator uses believing they disabled the thing.
  it.each([undefined, '', ' ', '0', 'false', 'off', 'no', 'ture', 'enabled'])(
    'reads %p as disabled',
    (raw) => {
      expect(parseBooleanEnv(raw)).toBe(false);
    },
  );
});

describe('isHttpsUrl', () => {
  it('accepts an https origin', () => {
    expect(isHttpsUrl('https://lopay-backend.onrender.com')).toBe(true);
  });

  it('rejects http', () => {
    expect(isHttpsUrl('http://localhost:3001')).toBe(false);
  });

  it('ignores surrounding whitespace', () => {
    expect(isHttpsUrl('  https://api.example.com  ')).toBe(true);
  });

  // Fail closed: an unparseable or missing URL must not be treated as TLS, because
  // every posture flag that says "yes" on the strength of it would then be wrong in
  // the permissive direction.
  it.each([undefined, '', 'not-a-url', '://broken'])('rejects %p', (raw) => {
    expect(isHttpsUrl(raw)).toBe(false);
  });
});

describe('resolveSecurityPosture', () => {
  // The regression this module exists for: the live Render deploy runs
  // NODE_ENV=development on purpose (the Joi schema demands a live Paystack key and
  // a 64-hex ENCRYPTION_KEY once NODE_ENV=production), and the old gates therefore
  // dropped HSTS, dropped the CSP, published Swagger, and left the session cookie
  // SameSite=Lax — on a public https host. Posture must not consult NODE_ENV at all.
  it('hardens an https deployment even when NODE_ENV is development', () => {
    const posture = resolveSecurityPosture({
      NODE_ENV: 'development',
      BETTER_AUTH_URL: 'https://lopay-backend.onrender.com',
    });

    expect(posture.httpsDeployment).toBe(true);
    expect(posture.hsts).toBe(true);
    expect(posture.contentSecurityPolicy).toBe(STRICT_API_CSP);
    expect(posture.crossSiteCookies).toBe(true);
    expect(posture.apiDocsEnabled).toBe(false);
  });

  it('leaves local http development on the relaxed settings that work there', () => {
    const posture = resolveSecurityPosture({
      NODE_ENV: 'development',
      BETTER_AUTH_URL: 'http://localhost:3001',
    });

    expect(posture.httpsDeployment).toBe(false);
    // HSTS over http is meaningless, and SameSite=None without Secure is dropped by
    // the browser — so on http both would be noise at best.
    expect(posture.hsts).toBe(false);
    expect(posture.crossSiteCookies).toBe(false);
  });

  it('does not soften an https deployment when NODE_ENV says production', () => {
    const posture = resolveSecurityPosture({
      NODE_ENV: 'production',
      BETTER_AUTH_URL: 'https://api.example.com',
    });
    expect(posture.hsts).toBe(true);
    expect(posture.crossSiteCookies).toBe(true);
  });

  describe('API docs', () => {
    it('are off when unset — a missing setting must close the door', () => {
      const posture = resolveSecurityPosture({
        BETTER_AUTH_URL: 'https://api.example.com',
      });
      expect(posture.apiDocsEnabled).toBe(false);
      expect(posture.contentSecurityPolicy).toBe(STRICT_API_CSP);
    });

    it('are served only on an explicit opt-in', () => {
      const posture = resolveSecurityPosture({
        BETTER_AUTH_URL: 'http://localhost:3001',
        API_DOCS_ENABLED: 'true',
      });
      expect(posture.apiDocsEnabled).toBe(true);
    });

    // Swagger UI is HTML with inline assets, which `default-src 'none'` blanks out.
    // The CSP yields to it rather than the other way round, so enabling docs cannot
    // leave a developer staring at an empty page.
    it('withhold the CSP so Swagger UI can render', () => {
      const posture = resolveSecurityPosture({
        BETTER_AUTH_URL: 'https://api.example.com',
        API_DOCS_ENABLED: '1',
      });
      expect(posture.contentSecurityPolicy).toBeNull();
    });

    it('still keeps HSTS on when docs are enabled', () => {
      const posture = resolveSecurityPosture({
        BETTER_AUTH_URL: 'https://api.example.com',
        API_DOCS_ENABLED: '1',
      });
      expect(posture.hsts).toBe(true);
    });
  });

  describe('client IP header', () => {
    it('is null when unset, so nothing is trusted by default', () => {
      expect(resolveSecurityPosture({}).clientIpHeader).toBeNull();
    });

    it('is lowercased for direct lookup against Node header keys', () => {
      expect(
        resolveSecurityPosture({ CLIENT_IP_HEADER: 'CF-Connecting-IP' })
          .clientIpHeader,
      ).toBe('cf-connecting-ip');
    });

    it('treats a whitespace-only value as unset', () => {
      expect(
        resolveSecurityPosture({ CLIENT_IP_HEADER: '   ' }).clientIpHeader,
      ).toBeNull();
    });
  });

  // Found in self-review: the tight per-path credential budgets are only safe when
  // the key identifies one caller. On a shared bucket they become a lockout
  // primitive, so the posture has to say which situation it is in.
  describe('trustedPerClientIp', () => {
    it('is false on a TLS deployment with no declared header', () => {
      expect(
        resolveSecurityPosture({ BETTER_AUTH_URL: 'https://api.example.com' })
          .trustedPerClientIp,
      ).toBe(false);
    });

    it('is true once the edge header is declared', () => {
      expect(
        resolveSecurityPosture({
          BETTER_AUTH_URL: 'https://api.example.com',
          CLIENT_IP_HEADER: 'cf-connecting-ip',
        }).trustedPerClientIp,
      ).toBe(true);
    });

    // No proxy in front, so the socket address IS the caller and the tight budgets
    // are correct without any header at all.
    it('is true for local http development', () => {
      expect(
        resolveSecurityPosture({ BETTER_AUTH_URL: 'http://localhost:3001' })
          .trustedPerClientIp,
      ).toBe(true);
    });
  });
});
