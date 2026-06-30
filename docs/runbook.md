# Lopay — Operations Runbook

Operational reference for running and securing Lopay in production. Started in
Milestone 2 (secure delivery); grows each milestone. See also the ADRs in
[`docs/adr/`](./adr/).

---

## Auth: session & cookie model

Identity is **Better Auth** (email/password + Google). The API guard
(`BetterAuthGuard`) accepts **either** a session cookie **or** an
`Authorization: Bearer` token — see [ADR 0003](./adr/0003-firebase-to-better-auth.md).

Two transports run in parallel (dual-path), chosen by the client at load time
(`services/platform.ts`):

- **Native (Capacitor):** always **bearer**. The token lives in `localStorage`
  and is sent on HTTP requests and in the socket handshake.
- **Web:** **cookie** when built with `VITE_WEB_AUTH_MODE=cookie`, otherwise the
  legacy **bearer** path (the current default).

### Enabling web cookie mode (cutover checklist)

1. Set `CORS_ORIGINS` to the exact SPA origin(s) — this turns on CORS
   `credentials: true` (`main.ts`). Wildcard origins cannot be used with cookies.
2. Confirm the API is HTTPS in production (required for `Secure` cookies).
3. Production sets `sameSite:'none', secure:true, httpOnly:true` on the session
   cookie automatically (`auth.config.ts` → `advanced.defaultCookieAttributes`).
4. Build the SPA with `VITE_WEB_AUTH_MODE=cookie`.
5. **Verify in staging** (cannot be proven by unit tests): web login sets the
   cookie; authenticated API calls and the realtime socket both work with no
   bearer token in `localStorage`; native (bearer) is unaffected.
6. The web bearer / `localStorage` path is removed in **Milestone 5** after
   verification — not before.

### Token rotation / forced logout

- A `401` from the API dispatches `lopay:unauthorized` on the web client, which
  triggers `logout()` (clears local state + revokes the server session).
- Soft-deleting a user (`UsersService.remove`) or a school
  (`SchoolPaymentsService.deleteSchool`) **revokes all sessions**
  (`session.deleteMany`) and anonymizes the email, freeing it for re-registration.

---

## Content-Security-Policy (SPA)

The SPA build injects a `<meta http-equiv="Content-Security-Policy">` (see
[`build/csp.ts`](../../Lopay/build/csp.ts), injected by `vite.config.ts` on
`vite build` only — dev is exempt so HMR works).

Core rule: **`script-src 'self'`** (no `unsafe-inline`/`unsafe-eval`). Allowed
external origins:

| Directive | Origins | Reason |
|---|---|---|
| `script-src` | `'self'`, `https://js.paystack.co` | Paystack inline checkout |
| `connect-src` | `'self'`, `<API origin>`, `<API ws origin>`, `https://api.paystack.co` | API, realtime socket, Paystack |
| `style-src` | `'self'`, `'unsafe-inline'`, `https://fonts.googleapis.com` | Tailwind + Google Fonts |
| `font-src` | `'self'`, `https://fonts.gstatic.com`, `data:` | Google Fonts |
| `img-src` | `'self'`, `data:`, `blob:`, `https:` | logos / receipts |
| `frame-src` | `https://checkout.paystack.com` | Paystack popup |

The `connect-src` API origin is derived from `VITE_API_URL` at build time — set
it correctly per environment or the SPA cannot reach the API/socket.

---

## Secrets & TLS

- **`GEMINI_API_KEY` (rotate):** an earlier build inlined this AI provider key
  into the client bundle via a Vite `define` block. The `define` block and the
  CDN import map that pulled the AI SDK are removed. If the key was ever present
  in a build/CI environment, **rotate it** — anything shipped to the browser must
  be considered public. The app does not use Gemini; no replacement is needed.
- **DB TLS CA pinning:** set `DATABASE_CA_CERT` to the database CA certificate
  (PEM contents). When set, the pg pool connects with `rejectUnauthorized: true`
  and verifies the server certificate against it. When unset (current default),
  it falls back to `rejectUnauthorized: false` and logs a warning at boot — set
  the CA to close that MITM gap (`prisma.service.ts`).
- **`PAYSTACK_WEBHOOK_ALLOWED_IPS` (optional):** comma-separated Paystack IPs.
  When set, webhooks from other IPs are rejected (defense-in-depth on top of the
  HMAC signature, which remains the primary control).

---

## Public endpoint shapes

- **`GET /schools`** (unauthenticated): returns `{ id, name }` only. School
  email/address/phone are PII and are never exposed here; search is by name only.
- **`GET /payments/paystack/verify`**: scoped to the caller's own payment
  (parent of the enrolled child, or the school's owner). A foreign reference is
  `403`; an unknown one is `404`.

## Money ledger: reversals & audit interpretation

All money-state changes are owned by `LedgerService` (`src/ledger/`, see
[ADR 0004](./adr/0004-ledger-service-ownership.md)). Every transition writes an
`AuditLog` row **inside the same transaction** as the balance change, so the log
and the balances can never disagree.

### Reversing a confirmed installment

`reversePayment` (school-owner action) is the auditable undo for a **confirmed
`SUCCESS` installment** (first-payment reversals are intentionally not supported
here — they change the enrollment lifecycle). It:

1. Flips the payment to `REVERSED` with a guarded write — a double-tap/replay
   finds `count === 0` and aborts, so the balance is restored **exactly once**.
2. Atomically **increments** `remainingBalance` by the paid amount, **clamped**
   so a restored balance can never exceed `totalSchoolFee`.
3. Reopens a `COMPLETED` enrollment back to `ACTIVE`.
4. Records `PAYMENT_REVERSED` (with the operator's `reason`, and
   `metadata.reopened`) and notifies the parent.

If a reversal is requested and none applies, the API returns `400` ("No confirmed
installment payment found to reverse") — that is the guard, not an error to retry.

### Reading the audit log

```
docker exec -it lopay-db psql -U lopay -d lopaydb -c \
  "SELECT action, \"entityId\", \"createdAt\", metadata FROM \"AuditLog\" ORDER BY \"createdAt\" DESC LIMIT 20;"
```

- `actor` is `null` for **system** actions — currently only the nightly
  defaulter sweep (`metadata.source = 'scheduled-defaulter-detection'`).
- `FIRST_PAYMENT_PAID` carries `paystackFeeDelta` (actual − estimated Paystack
  fee, in kobo). A non-zero value is expected occasionally; investigate
  **sustained** drift — the platform account bears that fee.
- `before`/`after` capture the pre/post `status`, `isConfirmed`, and
  `remainingBalance`, so a balance can be reconstructed by replaying the rows.
