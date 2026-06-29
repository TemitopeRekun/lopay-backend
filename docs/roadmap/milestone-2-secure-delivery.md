# Milestone 2 — Secure delivery & the auth/identity slice

> Part of the [Roadmap to 10/10](./README.md). Read the shared **non-breaking contract** there.

**Theme:** Close every externally-reachable security finding, end-to-end, with tests proving the boundaries. This is the highest-stakes externally-exploitable surface.

**Why second:** Small, self-contained, high-impact; depends on M1's strict types + auth-guard tests to refactor the auth boundary safely.

**Dimensions advanced:** Security 8.0 → 9.5 · Test coverage 6.0 → 7.0 · Documentation 4.0 → 5.0

---

## Database
- Add a partial-unique / `deletedAt`-aware uniqueness handling so a soft-deleted email/owner can re-register (latent issue once soft-delete is exercised). Additive migration.
- (Prep only) confirm no PII-column rename needed yet — encryption lands as additive columns in M3/M5 if pursued.

## Backend
- **Restrict the public directory:** `GET /schools` (`schools.management.controller.ts:23-27`) returns only `{id, name}` (drop `email/address/phone`). *(Security LOW — PII harvest)*
- **Scope `/payments/paystack/verify`** (`paystack-webhook.controller.ts:122-140`) to the caller's own payment (lookup by reference **and** parent/school).
- Fix the `PATCH` vs `@Put(':id')` `/users/:id` mismatch; add a proper self-service profile endpoint scoped to `@CurrentUser`. Remove or implement the dead `POST /notifications/broadcast`.
- Align `CreateSchoolDto.ownerPassword` `@MinLength` to 8 (match Better Auth); pin the DB TLS CA instead of `rejectUnauthorized:false` (`prisma.service.ts:19-20`).

## Frontend
- **Delete the Gemini key leak:** remove the `define` block (`vite.config.ts:16-19`) and the `@google/genai` importmap entry (`index.html`); rotate `GEMINI_API_KEY` if ever built. *(Security HIGH)*
- **Lock down SPA delivery:** drop the third-party CDN importmap and bundle react/react-dom/react-router locally via Vite; add SRI to any remaining external assets; ship a SPA `Content-Security-Policy` (`script-src 'self'`, `connect-src` limited to API/Paystack/socket origins). *(Security MED)*
- **Token storage (dual-path):** for the web origin, move the Better Auth session to an httpOnly+Secure+SameSite cookie; keep the bearer/`localStorage` flow **only** for the Capacitor native shell, selected at runtime. The old web `localStorage` path is removed in M5 after verification.

## Tests (all layers)
- **Backend unit:** `paystack-webhook.controller.spec.ts` — valid HMAC accepted; tampered/short/empty signature → 401; missing secret → 500; missing rawBody → 500; bad JSON → 400; IP allowlist allow/deny; verify-on-return ownership scoping.
- **Backend e2e:** extend the existing real-DB e2e with 401/403 boundary assertions (anon, wrong-role, cross-tenant) and the `/schools` public-shape assertion.
- **Frontend:** Testing Library tests for auth-guarded routes (redirect when unauthenticated), login/token persistence with msw, and a CSP smoke check in the build output.

## Docs / Ops
- `docs/adr/0003-firebase-to-better-auth.md`. Runbook section: session/cookie model, token rotation, CSP origins.

## Definition of done
No secret in the client bundle, SPA served under CSP with locally-bundled deps, public endpoints leak no PII, webhook + verify fully tested. Web auth works via cookie **and** native still works via bearer (dual-path verified by tests). (Plus the shared non-breaking contract.)
