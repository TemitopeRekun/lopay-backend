# Milestone 5 — Contract, documentation & observability completeness

> Part of the [Roadmap to 10/10](./README.md). Read the shared **non-breaking contract** there.

**Theme:** Make the system self-describing, fully documented, and operable — and finish the test pyramid with a full-journey E2E. This is the capstone that takes Documentation from 3→10 and locks the rest at 10.

**Why last:** Documents and contracts should describe the *final* shape after M2–M4 reshape auth, the ledger, and scaling.

**Dimensions advanced:** Documentation 6.5 → 10 · Security 9.5 → 10 · Code quality 9.5 → 10 · Test coverage 9.0 → 10 · Modularity 9.5 → 10 · Scalability 9.5 → 10

---

## Database
- _(none — finalize encryption-at-rest contract docs if pursued in M3)_

## Backend
- Run `npm run generate:swagger` → **commit `openapi.json`**; fix the output-path comment in `generate-swagger.ts:10`. Add a CI check that fails if `openapi.json` is stale vs. code.
- Confirm Sentry (`SENTRY_DSN`) + correlation IDs are wired end-to-end; add payment-volume / confirm-latency / failure-rate metrics + a "confirmations stalled > 1h" alert.

## Frontend
- Run `npm run generate:types` → **commit `src/api.generated.ts`**; migrate hand-written `backend.ts`/`adapters.ts` types to the generated client where sensible (shrinks the 16 `as any` casts in `adapters.ts`). Remove the now-unused web `localStorage` token path from M2.
- Decompose the 3 oversized dashboard pages (`OwnerDashboard` 629, `PaymentMethodsScreen` 598, `ProfileScreen` 552) into presentational subcomponents; remove the leftover `UIContext` shim.

## Tests (all layers)
- **Contract:** a test asserting the FE generated client matches the committed `openapi.json`.
- **E2E (capstone):** Playwright journey — parent enroll → Paystack first payment → installment → owner confirm → balance updates → reversal — reusing the flow in `scripts/e2e-verify.ts`, with `data-testid` selectors. Wire into CI.
- **Coverage:** ratchet the gate to 80%+ on both repos.

## Docs / Ops
- **Rewrite** both `README.md`, both `API_GUIDE.md` (from the spec: Better Auth `/api/auth/*`, the `/api/v1` prefix on every path, port 3001, Paystack endpoints, Firebase-Storage receipts; de-dupe the corrupted blocks), and `.env.example` (mirror the Joi schema exactly — drop `SUPABASE_*`, add Firebase/Better-Auth/Paystack vars). Fix "React Native" → "React + Vite + Capacitor". Mark Paystack/Push/Webhooks done.
- Refresh `LOCAL_DEV.md` and the CI secrets list (drop `JWT_SECRET`/`FIREBASE_*`-as-auth framing). Add `CONTRIBUTING.md`, `CHANGELOG.md` (seed from the audit remediation logs), and finalize `docs/adr/` + the ops runbook. Remove stray `server2.log`/`server2.err`.

## Definition of done
OpenAPI spec + generated client committed and CI-guarded; all docs match the shipped system; 80%+ coverage on both repos; a full user-journey Playwright E2E passes in CI; observability + alerting live. **All six dimensions at 10/10.** (Plus the shared non-breaking contract.)
