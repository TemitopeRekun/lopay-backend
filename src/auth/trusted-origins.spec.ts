import {
  LOCAL_DEV_ORIGINS,
  NATIVE_ORIGINS,
  buildTrustedOrigins,
} from './trusted-origins';

describe('buildTrustedOrigins', () => {
  const prod = {
    corsOrigins: 'https://lopay.netlify.app',
    betterAuthUrl: 'https://lopay-backend.onrender.com',
    httpsDeployment: true,
  };

  it('includes the configured web origins', () => {
    expect(buildTrustedOrigins(prod)).toContain('https://lopay.netlify.app');
  });

  it('includes the API own origin', () => {
    expect(buildTrustedOrigins(prod)).toContain(
      'https://lopay-backend.onrender.com',
    );
  });

  it('splits and trims a multi-origin CORS_ORIGINS', () => {
    const origins = buildTrustedOrigins({
      ...prod,
      corsOrigins: 'https://a.example.com , https://b.example.com',
    });
    expect(origins).toContain('https://a.example.com');
    expect(origins).toContain('https://b.example.com');
  });

  describe('native shell origins', () => {
    // Dropping either of these in production breaks sign-in for every mobile user,
    // so they are not environment-scoped.
    it.each(NATIVE_ORIGINS)('keeps %s in production', (origin) => {
      expect(buildTrustedOrigins(prod)).toContain(origin);
    });

    // Android's origin follows Lopay/capacitor.config.json's
    // `server.androidScheme: "https"`. Trusting the http spelling would widen the
    // CSRF and redirect surface for an origin this app never actually uses.
    it('trusts https://localhost for Android, not http://localhost', () => {
      const origins = buildTrustedOrigins(prod);
      expect(origins).toContain('https://localhost');
      expect(origins).not.toContain('http://localhost');
    });

    it('trusts capacitor://localhost for iOS', () => {
      expect(buildTrustedOrigins(prod)).toContain('capacitor://localhost');
    });
  });

  describe('local development origins', () => {
    // The bug being fixed: these were pushed unconditionally, so every deployed API
    // extended both its CSRF allowlist and its permitted redirect targets to
    // anything able to bind a localhost port on a victim's machine.
    it.each(LOCAL_DEV_ORIGINS)(
      'withholds %s from an https deployment',
      (origin) => {
        expect(buildTrustedOrigins(prod)).not.toContain(origin);
      },
    );

    it.each(LOCAL_DEV_ORIGINS)('allows %s on local http', (origin) => {
      const origins = buildTrustedOrigins({
        corsOrigins: '',
        betterAuthUrl: 'http://localhost:3001',
        httpsDeployment: false,
      });
      expect(origins).toContain(origin);
    });

    it('still trusts the native origins locally', () => {
      const origins = buildTrustedOrigins({
        corsOrigins: '',
        betterAuthUrl: 'http://localhost:3001',
        httpsDeployment: false,
      });
      for (const origin of NATIVE_ORIGINS) expect(origins).toContain(origin);
    });
  });

  it('de-duplicates while preserving first-seen order', () => {
    const origins = buildTrustedOrigins({
      corsOrigins: 'https://lopay.netlify.app,https://lopay.netlify.app',
      betterAuthUrl: 'https://lopay.netlify.app',
      httpsDeployment: true,
    });
    expect(
      origins.filter((o) => o === 'https://lopay.netlify.app'),
    ).toHaveLength(1);
    expect(origins[0]).toBe('https://lopay.netlify.app');
  });

  it('tolerates a missing CORS_ORIGINS and BETTER_AUTH_URL', () => {
    const origins = buildTrustedOrigins({ httpsDeployment: false });
    expect(origins).toEqual([...NATIVE_ORIGINS, ...LOCAL_DEV_ORIGINS]);
  });

  it('never emits an empty-string origin', () => {
    const origins = buildTrustedOrigins({
      corsOrigins: ',, ,',
      betterAuthUrl: '  ',
      httpsDeployment: true,
    });
    expect(origins).not.toContain('');
    expect(origins).toEqual([...NATIVE_ORIGINS]);
  });
});
