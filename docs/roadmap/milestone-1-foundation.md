# Milestone 1 — Foundation: type safety, domain constants & the test harness

> Part of the [Roadmap to 10/10](./README.md). Read the shared **non-breaking contract** there.

**Theme:** Build the safety net every later slice leans on — a strict compiler, one home for business constants, and a working test+CI pipeline across both repos. Nothing here changes runtime behavior, so it cannot break the product.

**Why first:** You cannot safely do the M3 ledger refactor or the M4 perf work without strict types and a test gate to catch regressions. This slice makes every subsequent change provable.

**Dimensions advanced:** Code quality 7.5 → 9.0 · Test coverage 3.5 → 6.0 · Modularity 6.5 → 7.0 · Documentation 3.0 → 4.0

---

## Database
- _(none — foundation slice)_

## Backend
- Turn on `strict: true` in `tsconfig.json` (remove `strictBindCallApply:false`); flip ESLint `@typescript-eslint/no-explicit-any` → `error` and `no-floating-promises`/`no-unsafe-argument` → `error`. Fix the fallout incrementally (file-by-file, each commit green). *(Code quality — root cause of ~48 `any`s)*
- Add a typed `AuthUser` interface; make `CurrentUser` a generic param decorator returning it (`common/decorators/user.decorator.ts`); replace `@CurrentUser() user: any` across ~25 controller sites.
- Create `common/fees.ts`: `PLATFORM_FEE_RATE = 0.025`, `FIRST_PAYMENT_DEPOSIT_RATE = 0.25`, `WEEKLY_INSTALLMENTS = 12`, `MONTHLY_INSTALLMENTS = 3`. Replace redeclarations in `payment.service.ts:76-77,132-133,213` and `admin.service.ts:605`.
- Extract one shared `toPaymentDto` (kobo→naira + name fields) mapper; replace the ~7 duplicated enrichers.
- Convert `catch (… : any)` → `catch (… : unknown)` with a single `errorMessage(e)` helper.

## Frontend
- Stand up test tooling: add `vitest`, `@testing-library/react`, `jsdom`, `msw`; add a `test` script + `vitest.config.ts`.
- Extract `getErrorMessage(error, fallback)` and replace the 6 duplicated `useQueries.ts` `onError` blocks; add a small logger wrapper to replace the 21 raw `console.*`.
- Consume the platform-fee rate from the API field instead of the client-side recompute in `ConfirmPlanScreen.tsx:69-74` (single source of truth with `common/fees.ts`).

## Tests (all layers)
- **Backend unit:** add `roles.guard.spec.ts` + `better-auth.guard.spec.ts` (cheap, high-value RBAC coverage). Replace the 3 `toBeDefined()` smoke specs (`admin.service`, `admin.controller`, `notifications.controller`) with real behavioral tests.
- **Coverage gate:** add `coverageThreshold` to the jest block (start `lines/functions:70, branches:60`; exclude `*.module.ts`, `*.dto.ts`, `generated/`, `main.ts`).
- **CI:** update `.github/workflows/node-ci.yml` — add a Postgres `services:` container, run `migrate:deploy` + `test:cov` (enforces the gate) + **`test:e2e`** (the real-DB spec never runs in CI today). Add a frontend CI job running `vitest`.
- **Frontend unit:** first tests — naira formatting + the new `getErrorMessage` helper + one Zustand store.

## Docs / Ops
- Add `docs/adr/0001-integer-kobo-money.md` and `0002-fee-policy.md` capturing the value-object + fee-rate decisions now centralized.

## Definition of done
Strict mode on, zero `any` in new code, all suites green under the new coverage gate, e2e + frontend tests run in CI, fee constants have exactly one home. **No runtime behavior changed.** (Plus the shared non-breaking contract.)
