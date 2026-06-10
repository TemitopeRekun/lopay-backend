/**
 * Test stub for `@thallesp/nestjs-better-auth`.
 *
 * The real package is ESM-only (`dist/index.mjs`) and Jest's ts-jest (CommonJS)
 * transform can't load it, which previously crashed every spec that
 * transitively imports it (events.gateway, admin.service, notifications, ...).
 *
 * Specs that exercise this code provide their own mocks for AuthService and
 * never import AuthModule, so empty placeholder classes are sufficient to let
 * the module graph load.
 */

export class AuthService {}

export class AuthModule {
  static forRoot() {
    return { module: AuthModule };
  }
}
