# ADR 0003 — Firebase Auth → Better Auth, with a dual-path session model

**Status:** Accepted
**Date:** 2026-06-29 (documenting the auth migration + the Milestone 2 session work)

## Context

Lopay originally authenticated with Firebase Auth and a separate backend JWT. That
meant two identity systems to keep in sync, a Google dependency for every login,
and a hand-rolled JWT guard. The product runs on two surfaces from one codebase:
a **web SPA** (separate origin from the API) and a **Capacitor native shell**
(Android webview, origin `capacitor://localhost`).

Two questions had to be settled:

1. What owns identity?
2. How does each surface carry its session to the API (and the realtime socket)?

## Decision

### Identity: Better Auth

Better Auth (email/password + Google social) is the single identity system,
sharing the app's Prisma client/pool (`auth.config.ts`). A `customSession` plugin
injects `role` + `schoolId` so the NestJS `BetterAuthGuard` populates
`request.user = { userId, role, schoolId }` — the shape the whole codebase already
expected. `role` is `input:false`: public sign-ups cannot self-assign a role
(everyone is `PARENT`; elevated roles are set server-side).

### Session transport: dual-path (Milestone 2)

`BetterAuthGuard` validates via `auth.api.getSession(headers)`, which Better Auth
resolves from **either** a session cookie **or** an `Authorization: Bearer` token.
The backend therefore supports both transports with no per-request branching. The
client picks one at load time (`services/platform.ts`, `getAuthMode`):

| Surface | Transport | Why |
|---|---|---|
| **Native (Capacitor)** | **Bearer** token in `localStorage`, replayed as `Authorization: Bearer` (HTTP) and in the socket handshake | Cross-origin cookies are unreliable in the native webview; bearer is the portable path. |
| **Web** | **httpOnly + Secure + SameSite=None** session cookie (`withCredentials`), nothing in JS | XSS cannot read an httpOnly cookie; the SPA's strict CSP already blocks script injection. |

Web cookie mode is **opt-in** behind `VITE_WEB_AUTH_MODE=cookie` and defaults to
the proven bearer path. Both paths coexist (the roadmap's non-breaking "risky
swap ships dual-path behind a flag" rule); the web bearer/`localStorage` path is
retired in Milestone 5 once the cookie path is verified in staging. Cross-origin
cookie attributes are set in production via `advanced.defaultCookieAttributes`
(`sameSite:'none', secure:true, httpOnly:true`); CORS already enables credentials
when `CORS_ORIGINS` is set.

`isAuthenticated` is derived from the presence of the hydrated **user**, not the
bearer token — the user is the source of truth in both modes.

## Consequences

- One identity system; the guard is transport-agnostic.
- Web sessions can be moved fully out of JS reach (httpOnly cookie) without
  touching native, which keeps bearer.
- The trade-off is a temporary dual code path on the client (two `fetchOptions`
  shapes, two socket auth shapes) until M5 removes the web bearer path.
- Operational notes (cookie attributes, CSP origins, rotation) live in
  [`docs/runbook.md`](../runbook.md).
