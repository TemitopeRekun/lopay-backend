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

### Parents who paid before the school joined Lopay

A school arriving mid-term has families part-way through paying, whose money
exists only in the school's own records. They cannot use the normal flow — it
starts with a Paystack deposit, and they have already paid. `EnrollmentInvite`
carries them across. See [ADR 0006](docs/adr/0006-enrollment-invites.md) for why
it is shaped this way.

**The school issues an invite.** `POST /api/v1/enrollment-invites` with the
student, class, amount already paid, the parent's phone, and the plan's cadence
and dates. The fee is read from the school's published `ClassFee` — it is not a
request field. The response carries `claimUrl`, a `wa.me` deep link and
pre-written text; there is no automated delivery, the school sends it over the
WhatsApp thread it already has with that parent. **The raw token appears in that
response and nowhere else, ever** — only its SHA-256 digest is stored, so a lost
link is recovered by revoking and re-issuing.

`termEndDate` is **not** accepted: it is derived from `planStartDate` and
`installmentFrequency`, because it is the point at which an unpaid plan is
marked as defaulting and the instalment count is fixed. Supplying it would let
one family default early and another never default at all. The response carries
the derived value.

`claimUrl` is `https://app/#/claim-invite?token=…`. The web client is
hash-routed, so the route has to sit inside the fragment — a link with it in the
real path reaches the SPA fallback and matches nothing. That also keeps the
token private: everything after the `#` is fragment and is never transmitted,
so it reaches no access log and no `Referer`. The three API routes below keep it
out of URLs entirely, for the same reason.

**The parent reviews it.** `GET /api/v1/enrollment-invites/preview` with the
token in an `x-invite-token` header (not the query string — it is a bearer
credential). This route is public: the parent usually has no account yet and must
be able to read what is being asserted before signing up. The response is a thin
projection — no phone number, no ids.

**The parent confirms or contests.** `POST /api/v1/enrollment-invites/claim` or
`/dispute`, token in the body. Both require an authenticated account whose
`phoneHash` matches the number the invite was addressed to; the token alone is
not enough, because it travels over a chat app. Neither is role-gated — a school
owner can be a parent elsewhere.

A claim builds the Parent/Child/Enrollment graph and records the prior payment as
a confirmed `MIGRATED_PAYMENT` with no platform fee, in one transaction, through
`LedgerService`. It takes the place of the **deposit**, so the derived instalment
schedule opens from the balance it leaves; `termStartDate` is the handover date,
not the historical term start, so the plan is not born in arrears.

**Corrections.** `POST /enrollment-invites/:id/revoke` cancels a live invite and
frees the student's slot for a re-issue. Once claimed there is a real plan, so
the remedy is `POST /enrollment-invites/:id/amend`, which restates the figure on
the payment, the plan **and the invite** — so the school's own list stops showing
the number they just corrected — and re-derives the balance under a row lock,
refusing any correction that would leave the plan overpaid.
`GET /api/v1/enrollment-invites` lists a school's invites, including any dispute
reasons.

**What migrated money is not.** It reduces the plan's balance and appears in the
parent's history, but it is excluded from the "School Collections" figure and
from the admin's per-school collected total (`MOVED_THROUGH_LOPAY` in
`common/migrated-plan.ts`). The school banked that cash itself before Lopay was
involved; no rail carried it and `platformAmount` is zero, so counting it would
make a school's collections jump by months-old money the moment a parent claims.

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
