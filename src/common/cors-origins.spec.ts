import { resolveCorsAllowlist } from './cors-origins';
import { NATIVE_ORIGINS } from '../auth/trusted-origins';

const WEB = 'https://lopay.netlify.app';

describe('resolveCorsAllowlist', () => {
  describe('with an explicit CORS_ORIGINS', () => {
    it('keeps the configured web origins', () => {
      const { origin } = resolveCorsAllowlist(
        `${WEB},http://localhost:5173`,
        'production',
      );

      expect(origin).toEqual(
        expect.arrayContaining([WEB, 'http://localhost:5173']),
      );
    });

    // The regression this module exists for: the release APK could not sign up
    // (email or Google) because the preflight from the Android WebView came back
    // with no Access-Control-Allow-Origin at all.
    it('allows the Capacitor native origins even though CORS_ORIGINS omits them', () => {
      const { origin } = resolveCorsAllowlist(WEB, 'production');

      expect(origin).toEqual(expect.arrayContaining(['https://localhost']));
      expect(origin).toEqual(expect.arrayContaining(['capacitor://localhost']));
    });

    it('stays in sync with the Better Auth trustedOrigins native list', () => {
      const { origin } = resolveCorsAllowlist(WEB, 'production');

      expect(origin).toEqual(expect.arrayContaining([...NATIVE_ORIGINS]));
    });

    // Android is served over `https://localhost` (server.androidScheme: "https").
    // Trusting the http spelling would widen the surface for an origin the app
    // never uses — any process able to bind port 80 on a victim's machine.
    it('does not trust the http spelling of the Android origin', () => {
      const { origin } = resolveCorsAllowlist(WEB, 'production');

      expect(origin).not.toEqual(expect.arrayContaining(['http://localhost']));
    });

    it('de-duplicates a native origin already present in CORS_ORIGINS', () => {
      const { origin } = resolveCorsAllowlist(
        `${WEB},https://localhost`,
        'production',
      );

      expect(
        (origin as string[]).filter((o) => o === 'https://localhost'),
      ).toHaveLength(1);
    });

    it('trims whitespace and drops empty entries', () => {
      const { origin } = resolveCorsAllowlist(`  ${WEB} , , `, 'production');

      expect(origin).toEqual([WEB, ...NATIVE_ORIGINS]);
    });

    it('enables credentials only against the explicit allowlist', () => {
      expect(resolveCorsAllowlist(WEB, 'production').credentials).toBe(true);
    });
  });

  describe('with no CORS_ORIGINS', () => {
    it('reflects any origin in development', () => {
      expect(resolveCorsAllowlist(undefined, 'development').origin).toBe(true);
    });

    // Fails closed: an unconfigured production deploy must not quietly serve the
    // two native origins either.
    it('refuses every origin in production', () => {
      expect(resolveCorsAllowlist('', 'production').origin).toBe(false);
    });

    it('never pairs credentials with a reflected origin', () => {
      expect(resolveCorsAllowlist(undefined, 'development').credentials).toBe(
        false,
      );
    });
  });
});
