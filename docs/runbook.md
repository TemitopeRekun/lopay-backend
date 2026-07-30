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

---

## Scale & performance (Milestone 4)

Everything below is **additive and gated** — with none of the new env vars set,
the app runs exactly as before on a single instance.

### Multi-instance toggle: `REDIS_URL`

Set `REDIS_URL` to run safely on N instances. It is read once at boot
(`RedisModule`) and provides ONE shared connection to:

| Feature | Without `REDIS_URL` (default) | With `REDIS_URL` |
|---|---|---|
| Request throttler (`@nestjs/throttler`, 500/min) | in-memory, **per instance** | shared counters across instances |
| Auth brute-force limiter (`express-rate-limit`, 20/min) | in-memory, **per instance** | shared (`auth-rl:` keys) |
| Cache (class fees, bank list, dashboard aggregates) | in-process Map + TTL | shared Redis keys |
| Socket.IO fan-out | single instance | `@socket.io/redis-adapter` (pre-existing) |

> ⚠️ Before scaling past one instance you **must** set `REDIS_URL`. With
> per-instance in-memory limiters, an attacker's effective auth-attempt budget is
> `20 × instanceCount`/min, and throttle counts don't add up.

### Connection-pool sizing: `DATABASE_POOL_MAX`

Each instance opens a pg pool capped at `DATABASE_POOL_MAX` (default **10**).
Keep `instances × DATABASE_POOL_MAX` comfortably under Postgres'
`max_connections` (≈100 on small managed tiers), leaving headroom for migrations
and admin sessions.

**PgBouncer (recommended at scale):** front Postgres with PgBouncer in
*transaction* pooling mode, point `DATABASE_URL` at it, and append
`?pgbouncer=true&connection_limit=1`; then set `DATABASE_POOL_MAX` low (1–5) per
instance. PgBouncer multiplexes many app connections onto few server ones.

**Read replicas (analytics):** the heavy admin aggregates (`/admin/overview`,
`/admin/students/summary`, `/admin/schools/summary`) are read-only and cached
~30s. When a replica is available, route those reads to it (a second
`PrismaClient` bound to a `DATABASE_REPLICA_URL`) so dashboard load can't contend
with the transactional write path. Not wired yet — planned follow-up.

### Cache TTLs & invalidation

| Data | Key | TTL | Invalidation |
|---|---|---|---|
| Class fees (per school) | `cache:classfees:<schoolId>` | 5 min | **explicit** `del` on `createClassFee` |
| Paystack bank list | `cache:paystack:banks` | 24 h | TTL only |
| Platform revenue | `cache:admin:revenue` | 30 s | TTL only |
| Students summary | `cache:admin:students-summary` | 30 s | TTL only |
| Schools summary | `cache:admin:schools-summary` | 30 s | TTL only |

Aggregates use short TTLs instead of explicit invalidation — they tolerate a few
seconds of staleness and are cheap to recompute. To force-clear after a data fix,
`DEL` the key (or `FLUSHDB` a dedicated cache DB).

### Pagination (admin lists)

All admin list endpoints return `{ items, total, page, limit, totalPages }` and
**cap `limit` at 200** (default 50) via `common/pagination.ts` — no HTTP caller
can pull the whole table. Receipt signed-URLs are generated only for the current
page. `GET /admin/overview` uses a dedicated `take:10` recent-transactions query
(it no longer materialises every payment to slice ten). The SPA pages these lists
(`components/Pagination.tsx`).

### Paystack circuit breaker

`PaystackService` wraps its HTTP call in an `opossum` breaker (`name: 'paystack'`,
50% error threshold over ≥5 calls, 30s reset). When Paystack is failing, the
circuit OPENs and calls fail fast with **503** instead of piling up. 4xx business
errors (e.g. a bad account number) are excluded via `errorFilter` and never trip
it. Watch for the `Paystack circuit OPEN` log line.

### Applying the M4 index migration

`migration 20260630000001_add_scale_indexes` adds five additive indexes (no data
change). `prisma migrate deploy` applies them in a transaction with a brief lock —
fine for current table sizes. For very large `Payment` tables, build them
`CONCURRENTLY` out-of-band first (outside a transaction), then mark the migration
applied with `prisma migrate resolve --applied 20260630000001_add_scale_indexes`.
The hot `ORDER BY paymentDate DESC` path is covered by `Payment_paymentDate_idx`
(proven by the EXPLAIN assertion in `test/admin-pagination.e2e-spec.ts`).

## Observability (Milestone 5)

### Error tracking: `SENTRY_DSN`

Sentry is initialised at bootstrap and is a **no-op unless `SENTRY_DSN` is set**
(local/dev and any deploy without a DSN behave as before). Set `SENTRY_DSN` (and
optionally `SENTRY_TRACES_SAMPLE_RATE`, 0–1) in production. Unhandled 5xx errors
are reported by `GlobalExceptionFilter` with the request's `X-Request-ID`
correlation id; operational alerts use `captureMessage` (see below).

### Correlation IDs

Every request gets an `X-Request-ID` (generated if the client didn't send one) —
echoed in the response header, the HTTP access log, the 5xx log line, error
response bodies, and the Sentry context. Pass a client-supplied `X-Request-ID`
through your LB to trace a request end-to-end.

### Metrics: `GET /metrics`

Prometheus text-format endpoint, **public and outside the `/api/v1` prefix**
(scrape `https://<host>/metrics`). Point a Prometheus/Grafana Agent scrape job at
it. Exposed series (plus Node process defaults):

| Metric | Type | Meaning |
|---|---|---|
| `lopay_payments_total{outcome,type,receiver}` | counter | Money-state transition volume. `outcome` = confirmed/rejected/reversed/failed. **Failure rate** = `failed+rejected` share of the total. |
| `lopay_payment_confirm_latency_seconds{type}` | histogram | Time from payment submission to confirmation. |
| `lopay_confirmations_stalled` | gauge | Payments awaiting confirmation past the 1h threshold (set hourly by the stall check). |

Recorded by `LedgerService` (the single owner of money transitions), so every
money path is counted in exactly one place.

### Alert: confirmations stalled > 1h

`ConfirmationStallService` runs hourly (leader-locked so one instance fires when
scaled), counts payments that are `PENDING` + unconfirmed + older than 1h, sets
the `lopay_confirmations_stalled` gauge, and — when the count is non-zero —
raises a Sentry **warning** (`captureMessage`). Recommended paging rule: alert
when `lopay_confirmations_stalled > 0` for 2+ consecutive scrapes, or on the
Sentry message. A rising number means owners/admins aren't actioning pending
first-payment settlements or installment confirmations.
