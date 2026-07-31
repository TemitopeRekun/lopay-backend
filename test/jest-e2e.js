/**
 * Jest config for the end-to-end suites, which run against a REAL Postgres.
 *
 * Unlike the unit suites (configured under `jest` in package.json, fully
 * isolated), every spec here shares one database. That makes the two settings
 * below load-bearing rather than cosmetic — see the comments on each.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.e2e-spec.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@thallesp/nestjs-better-auth$': '<rootDir>/mocks/nestjs-better-auth.ts',
  },

  // The suites share ONE database, so they must not run concurrently.
  //
  // In parallel, one suite's writes land in the middle of another's
  // assertions. admin-pagination.e2e-spec.ts counts payments GLOBALLY
  // (`getTransactions(false, 'ALL', ...)`), so a Payment inserted by
  // security-boundaries or enrollment-recovery makes `total` drift between two
  // requests that are supposed to agree — the exact "Expected: 5, Received: 6"
  // failure this suite hit on master. Concurrent DB contention also blew the
  // default 5s hook timeout on slower machines.
  //
  // Serialising is the fix rather than a workaround: "the paginated total is
  // stable across pages" is a real property of the envelope, but it is simply
  // not observable while other writers are committing to the same tables.
  maxWorkers: 1,

  // Setup hooks provision schools, owners, parents, children, enrollments and
  // payments over a real DB before assertions begin. Jest's 5s default is not a
  // realistic budget for that and produced timeouts unrelated to the code under
  // test. Applies to hooks as well as tests.
  testTimeout: 30_000,
};
