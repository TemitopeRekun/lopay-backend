# LoPay API — Integration Guide

This is the **mental model** for integrating with the LoPay backend. For the
exact shape of every endpoint (paths, params, request/response bodies), use the
authoritative machine-readable contract:

- **[`openapi.json`](./openapi.json)** — committed, CI-guarded against drift.
- **Swagger UI** at `http://localhost:3001/api` (non-production only).
- The frontend consumes the same spec as a typed client
  (`Lopay/src/api.generated.ts`).

Read this guide once for the concepts; reach for the spec for the details.

---

## 1. The basics

| | |
|---|---|
| Base URL (local) | `http://localhost:3001` |
| App API prefix | **`/api/v1`** — e.g. `GET /api/v1/users/me` |
| Auth handler | **`/api/auth/*`** (Better Auth) — *outside* the `/api/v1` prefix |
| Health | `GET /health` (liveness + DB/storage checks) |
| Metrics | `GET /metrics` (Prometheus) |
| Content type | `application/json` (except receipt binary uploads, below) |

Every failed request returns `{ statusCode, message, requestId, timestamp,
path }`. Send an `X-Request-ID` header to correlate a request across logs, error
bodies, and Sentry; the server generates one if you don't.

## 2. Authentication (Better Auth)

Auth is handled by **Better Auth**, not a bespoke JWT. Identity is always taken
from the authenticated session on the server — **never** from a request body.

- Sign up / in / out and session lookup live under **`/api/auth/*`**
  (e.g. `POST /api/auth/sign-in/email`, `GET /api/auth/get-session`).
- Two transports are supported and both resolve to the same session:
  - **Cookie** — the browser/web app sends the Better Auth session cookie.
  - **Bearer** — native/mobile clients send `Authorization: Bearer <token>`.
- Protected endpoints are marked `bearer` in the OpenAPI spec and enforced by a
  global guard; role-restricted endpoints additionally require the caller's role.

**Roles:** `SUPER_ADMIN` (platform; login only), `SCHOOL_OWNER` (one school,
created by an admin), `PARENT` (public signup).

## 3. Receipt uploads (Firebase Storage, signed URLs)

Receipts live in a **private Firebase Storage** bucket; clients never get bucket
credentials. It is a two-step, backend-brokered flow:

1. `POST /api/v1/documents/receipts/upload-url` with `{ fileName, contentType }`
   → returns a short-lived `signedUrl`, the storage `path`, and any
   `requiredHeaders`.
2. `PUT` the file bytes directly to `signedUrl` with those headers.
3. Submit the returned `path` as the receipt reference on the payment/enrollment
   (`receiptUrl` is a **storage path**, not a public URL).

To display a receipt, call `POST /api/v1/documents/receipts/download-url` with
`{ paymentId }` for a short-lived read URL.

## 4. Payments

### First payment (Paystack)

First payments are collected by the platform via **Paystack split charges**:

1. The parent enrols a child (`POST /api/v1/enrollments`) indicating a first
   payment; the backend initialises a Paystack transaction and returns the
   access code / reference.
2. The client completes the charge with the **Paystack inline popup**.
3. Paystack calls the webhook **`POST /api/v1/payments/paystack`** (HMAC-verified,
   optionally IP-allowlisted). The backend reconciles the charge, activates the
   enrollment, and settles the school's share. A scheduled sweep reconciles any
   webhook that was missed.

### Installments

Ongoing installments are **receipt-based**: the parent submits a payment with a
receipt (`PENDING`), and the school owner **confirms** it (decrementing the
balance) or **reverses** a confirmed one (auditable undo). Every money transition
is owned by a single ledger and recorded in the audit log.

### Parents who paid before joining Lopay

Schools use `POST /api/v1/migration-invites` to create a one-time invite with
the student, fee, amount already paid, migration date, and plan frequency. The
backend returns a hashed-token-backed `inviteUrl` and normalized WhatsApp
number; the configured WhatsApp delivery layer should send the returned message
without exposing or creating a parent password.

The parent opens `GET /api/v1/migration-invites/preview?token=...`, signs in or
creates a normal Lopay parent account, then either confirms the amount and calls
`POST /api/v1/migration-invites/claim?token=...`, or disputes it with
`POST /api/v1/migration-invites/dispute?token=...` and a `{ "reason": "..." }`
body.

Claiming is atomic and one-time. It creates the normal child/enrollment records
and a confirmed `MIGRATED_PAYMENT` ledger row with no platform fee. The
enrollment's `termStartDate` is the migration date, so the existing due-date
projection starts from the handover rather than incorrectly treating the parent
as overdue for an earlier school payment.

## 5. End-to-end flow

1. **Discover** — parent lists schools and class fees (`/api/v1/schools`,
   `/api/v1/school-payments/fees/...`).
2. **Enrol + first payment** — `POST /api/v1/enrollments`; pay via Paystack;
   webhook reconciles → enrollment `ACTIVE`.
3. **Installments** — parent submits with a receipt (`PENDING`) → school confirms
   → balance decrements → `COMPLETED` at zero.
4. **Reversal / default** — an owner can reverse a confirmed installment; overdue
   active enrollments are defaulted by the nightly sweep.
5. **History & reconciliation** — parents and owners read their payment history;
   admins read global transactions and the audit log.

Status lifecycle: `PENDING → ACTIVE → COMPLETED`, with `DEFAULTED` / `FAILED` /
`REVERSED` as terminal or again-actionable branches. The backend owns every
transition; clients render state, they never compute it.

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401` on `/api/v1/*` | No/expired session — re-authenticate via `/api/auth/*`. |
| `403` | Authenticated but wrong role for the endpoint. |
| `503` on a Paystack-backed call | Paystack circuit breaker is open (provider degraded) — retry shortly. |
| Receipt `PUT` rejected | Missing a `requiredHeader` from the upload-url response, or the signed URL expired. |
| Webhook not reconciling | Check the HMAC signature and, if set, `PAYSTACK_WEBHOOK_ALLOWED_IPS`; the sweep reconciles late. |

For anything endpoint-specific not covered here, the OpenAPI spec is the source
of truth.
