// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Generated Prisma client + build output are not hand-authored — don't lint them.
    // `coverage/**` is Istanbul's bundled HTML reporter assets: gitignored, but
    // ESLint still walks them unless told otherwise.
    ignores: [
      'eslint.config.mjs',
      'src/generated/**',
      'dist/**',
      'coverage/**',
      'node_modules/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // `any` is now a deliberate, reviewed exception — annotate genuine
      // third-party-boundary cases with an inline eslint-disable + reason.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      // Allow intentionally-unused names prefixed with `_` (e.g. required-but-unused
      // route params), matching the common TS convention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // Plain-JS config files (e.g. test/jest-e2e.js) are not in the TS project, so
    // the type-aware rules cannot run on them and error out at parse time.
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false },
    },
  },
  {
    // Test suites AND dev-tooling scripts. scripts/e2e-verify.ts drives the live
    // API and reads untyped JSON responses, so the no-unsafe-* family fires on
    // every property access. Those rules protect production code paths; applying
    // them here would only invite blanket `any` casts that hide nothing.
    files: ['test/**/*.ts', 'src/**/*.spec.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
);
