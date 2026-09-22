# ADR 0006 — Onboarding parents who paid before Lopay

**Status:** Accepted
**Date:** 2026-09-19

## Context

A school that adopts Lopay mid-term already has families part-way through paying
their fees. Those parents have no account, and the money they have handed over
exists only in the school's own records — a paper ledger or a spreadsheet.

Neither existing path works for them:

- **Normal enrollment** begins with a Paystack deposit
  (`EnrollmentService.initiateFirstPayment`). The manual route was deliberately
  removed so that no plan can open on money nobody collected. A migrating parent
  has already paid, off-platform, and must not be charged again.
- **Leaving them off** means the school's dashboard reports a fraction of its
  real book, and the families most likely to churn are the ones who see no
  benefit from the switch.

We also cannot pre-create these parents. `ChildEnrollment` hangs off
`Child → Parent → User`, and `User.email` / `User.phoneHash` are globally
unique, so placeholder users would burn those uniqueness slots and collide with
`signup-guard.ts` the moment the real parent signs up.

## Decision

A staging record — `EnrollmentInvite` — that the school fills in and the parent
converts.

### 1. The invite is not an enrollment

`EnrollmentInvite` sits outside the enrollment graph and holds the facts only.
The `Parent`/`Child`/`ChildEnrollment` rows are built once, at claim time, in a
single transaction. Until then nothing exists that a parent could be billed on.

### 2. The prior payment is a DEPOSIT, not instalments

This is the load-bearing decision. `common/installment-schedule.ts` does not
store a schedule; it reconstructs a plan's opening balance as

    planStartBalance = remainingBalance + confirmed INSTALLMENT payments

Recording migrated money as instalment rows would inflate that sum back to the
full fee, and the parent's next-due figure, their progress, the school's arrears
and the admin Overdue tab would all be wrong at once, each in a different
direction.

So it is written as a single `PaymentType.MIGRATED_PAYMENT` row and
`ChildEnrollment.firstPaymentPaid`, exactly where a deposit goes. Every
instalment sum in the codebase filters on equality with `INSTALLMENT`, so none
picks it up; `paidAmount` in `enrollment-view.ts` sums all confirmed payments, so
that one does. Both behaviours are correct, and neither needed changing.
`common/migrated-plan.ts` owns the derivation, in `common/` rather than beside
the feature because `LedgerService` needs it and the ledger must not depend on a
feature module.

#### Collections are the exception, and had to change

The audit above covers every sum that filters on a *payment type*. Two
aggregates filter only on `isConfirmed`/`status`, and a migrated row is written
SUCCESS-and-confirmed deliberately — there is no school confirmation step to
wait for, because the school is the party asserting it. So both picked it up:

- `SchoolsService.getDashboardStats` → the owner's **"School Collections"** tile
- `AdminService`'s per-school `collectedAmounts` breakdown

Both are labelled as collections, and a claim would have made them jump by cash
that was in an exercise book months earlier — dated to the handover, so it lands
in the current period. Migrated money is a real payment against a real plan, but
it is not money Lopay collected: no rail carried it and `platformAmount` is zero.
`MOVED_THROUGH_LOPAY` in `common/migrated-plan.ts` is the single filter both now
spread into their `where`, so the rule lives next to the reasoning for it instead
of being restated in two services.

### 3. The schedule is anchored to the handover, not the historical term

`planStartDate` is the date the family moves onto Lopay. Anchoring to the real
term start would open the plan already in arrears — on a MONTHLY cadence, a
two-month back-date greets the parent with two instalments overdue and puts them
on the school's Overdue tab for money nobody has had a chance to collect.
`validatePlanStart` allows 36 hours of back-dating for clock skew and the
UTC+1 offset, and nothing more.

#### The payment's DATE is clamped, the plan's anchor is not

`planStartDate` may legitimately be in the future — the allowance exists so a
school can set next term's migrations up early — and the migrated `Payment` row
was dated to it directly. A confirmed payment dated in the future is wrong on
every reading: it is not when the money was paid (months ago, off-platform), and
it is not when the record was made (now). `AdminService.recentTransactions`
orders by `paymentDate desc` with no upper bound, so each such row outranked
every genuinely recent transaction on the platform dashboard until that date
arrived.

`migratedPaymentDate` clamps it to `min(planStartDate, now)`. The plan's own
anchor is untouched — the schedule really does open next term — because the two
dates answer different questions: one is when collection starts, the other is
when this money became part of a Lopay plan.

### 3a. The plan's END is derived, not supplied

`termEndDate` looked like a second date for the school to fill in. It is not a
date about the school's term at all — everywhere else in the product it is the
*plan's* end, and `ConfirmPlanScreen` sets it to exactly the cadence's span
(`start + numberOfPayments` months, or `+ numberOfPayments * 7` days). The
instalment counts are fixed ([ADR 0002](./0002-fee-policy.md)), so a plan always
runs three months or twelve weeks however much term is left.

That column is a cliff, and two things read it:

- `DefaulterDetectionService` flips every ACTIVE enrollment to DEFAULTED once it
  is past and a balance remains;
- `computeArrears` returns the WHOLE remaining balance as overdue, and every
  unpaid slot as missed, the moment `now > termEndDate`.

A hand-typed date is therefore wrong in **either** direction, and validating it
only narrows the window instead of removing the asymmetry:

- **too early** — the cliff fires before the instalments are due. The family is
  defaulted and their whole balance lands on the admin's Overdue tab for money
  nobody has asked them for. On MONTHLY, a term ending inside a fortnight
  defaults them before instalment one.
- **too late** — the cliff never fires while the plan is alive, so that one
  family is exempt from defaulting and from the term-expiry escalation every
  normally-enrolled family is subject to, and the arrears book under-reports
  them.

So `derivePlanEnd(planStartDate, cadence)` computes it, from the same two
functions the schedule itself uses (`installmentDueDate`,
`installmentCountFor`) so it cannot drift from them, and the DTO does not accept
it. Both failures become unreachable rather than rejected, and a migrated plan
ends on precisely the value a normal enrollment would have written. It is the
same argument this ADR already makes for `totalSchoolFee`: the figures the whole
plan is derived from do not belong in a free-text box. The school still sees the
date — read-only, recomputed as they change the start or the cadence.

### 4. Claiming takes the link, and the link alone

The raw token — 32 random bytes, stored only as a SHA-256 digest, so a database
dump cannot be replayed into a claim. Nothing else.

An earlier version of this decision required a second factor: a `User.phoneHash`
matching the number the school addressed the invite to. **That requirement was
removed**, and the reasoning is worth keeping because it looked right.

It read as two-factor and was not. Lopay does not verify phone numbers anywhere
— there is no OTP, no SMS provider and no `phoneVerified` column — so a match
only ever established that somebody had typed that number into a signup form.
Against anyone holding the link and willing to do that, it bought nothing.

What it did reliably do was refuse the people this feature exists for. These
parents are, by its whole premise, new to Lopay:

- a Google sign-in carries no number at all (`signup-guard.ts` makes it optional
  precisely so that path works), so the check refused them outright;
- a parent on a second phone, or on the number their spouse registered, was
  refused;
- and when the school mistyped one digit, the check did not prevent the mistake
  — it **enforced** it. The wrong number became the only one that could claim,
  and the real parent was locked out of their own child's plan permanently.

The link is therefore the credential, deliberately. It is issued and sent inside
a conversation the school and the family have already had, so it arrives
expected rather than cold, and the school controls who receives it.

Authorisation is also **not** keyed on `UserRole`: a school owner may be a
parent at another school, and gating that person out of their own family's plan
is a bug this codebase already fixed once in
`EnrollmentService.submitInstallmentPayment`.

### 4a. The phone survives as a signal, and misuse is recoverable

Dropping the gate does not mean dropping the comparison. A bearer-link model is
only honest if the mistake it invites can be seen and undone, so three things
replace the refusal:

- **The comparison is still made, and stored.** `claimantPhoneMatched` records
  whether the claimant's own number was the one addressed, at the instant of the
  claim. Stored rather than recomputed on read because it is a fact about a
  moment: a claimant who later corrects their profile number would otherwise
  turn retroactively green, erasing the only trace that anything looked odd.
- **The school is told who claimed.** The notification names the account and its
  last three digits, and says so loudly when the number does not match — a claim
  reported in the abstract ("claimed by their parent") is one nobody can check.
  A mismatch links straight to the invite list, where the undo lives.
- **The school can undo it.** `release` deletes the plan, its payment rows and
  the `Child` record the claim invented, cancels the invite so a corrected one
  can be issued, and tells whoever claimed it. It refuses when confirmed
  instalments exist: real money has moved, and deleting the plan would destroy
  the only record of where it went.

`release` deletes where `amend` restates, and the difference is the point.
`amend` fixes a wrong FIGURE on the right family's plan. `release` is for a plan
that should never have existed, where there is no figure to restate and every
row records something that did not happen. Soft-voiding instead was rejected:
`ChildEnrollment` has no deleted state, and adding one means every roster query,
student count and revenue sum has to learn to exclude it — one that forgets
leaves a ghost family on a school's dashboard, a worse version of the problem
being fixed. The audit row carries the entire before-state, including the money
rows, so nothing is lost; it moves from a table read as "this school's students"
to one read as "what happened".

### 5. The parent confirms before anything becomes real

The already-paid figure is typed by hand and it *reduces what the platform can
collect*, so it is unverifiable and consequential. The parent — the one party
with both the knowledge and the incentive to spot an error — sees it and either
confirms or disputes before a plan exists.

### 6. Money still moves only through the ledger

`LedgerService.recordMigratedEnrollment` writes the enrollment, the payment and
the audit row ([ADR 0004](./0004-ledger-service-ownership.md)). It is the one
ledger method that takes a caller's transaction rather than opening its own,
because the claim must also flip the invite and materialise the Parent/Child
rows atomically — an invite left CLAIMED with no plan behind it is
unrecoverable, since the token is single-use.

Because that transaction belongs to the caller, **nothing observable outside the
database may be emitted inside it.** `announceMigratedEnrollment` holds all of
it — the realtime nudge, the Prometheus counter and the parent's notification —
and runs after the commit. The notification is the sharpest case: it is a row
written through the *non-transactional* client, plus a socket emit, plus an
awaited FCM multicast, so a rolled-back claim would leave the parent's phone
buzzing "Previous payments added" for a plan that does not exist. It is also a
network round-trip, and Prisma's interactive transactions default to a 5s budget
that the claim's six writes already draw on. The same split applies to
`amendMigratedPayment`.

For the same reason the `Child` row is resolved with an `upsert` rather than
find-then-create-catching-`P2002`. `EnrollmentService.resolveEnrollmentTarget`
uses that pattern and is right to, because it runs *outside* a transaction;
inside one it silently cannot work. PostgreSQL aborts the whole transaction on a
constraint violation and Prisma sets no per-statement `SAVEPOINT`, so the
recovery re-read fails with `25P02` and surfaces as a 500 where the code
intended a successful claim. `INSERT … ON CONFLICT` has no exception to
recover from. A violation that escapes anyway is mapped to a retryable 400,
because retrying genuinely is the recovery — the second attempt's reads see the
row that beat it.

### 7. Mistakes are correctable, in two different ways

Schools will get these wrong; it is manual data entry about past cash.

- **Before a claim:** revoke and re-issue. The uniqueness rule is a PARTIAL
  unique index over `(schoolId, studentName, className)` scoped to
  `PENDING/DISPUTED/CLAIMED`, so a revoked invite frees the slot immediately.
- **After a claim:** `LedgerService.amendMigratedPayment` restates the figure
  and re-derives the balance, refusing any correction that would leave the plan
  overpaid. Wholesale reversal would be the wrong shape — it would leave an
  ACTIVE plan claiming the parent paid nothing, a worse lie than the original
  typo.

  Two details are load-bearing. The balance and the status are both written from
  one recomputed figure, under a `SELECT … FOR UPDATE` on the enrollment row.
  An earlier draft set the balance by an atomic `increment: old − new` while
  taking the status from the recomputed total; those agree only while
  `remaining = fee − migrated − instalments` holds exactly, and `confirmPayment`
  clamps an overpaid balance to zero — so the row could commit COMPLETED with a
  non-zero balance, or ACTIVE at zero. The row lock makes a concurrent
  instalment confirmation block rather than interleave, which is what the
  increment was protecting against, so it buys nothing the lock does not already
  give.

  The status is the third. It is NOT re-derived from the new balance, because
  a correction restates a past figure rather than asserting where the family
  stands today. A migrated plan runs exactly the cadence's span, so passing
  `termEndDate` with a balance and being flipped to DEFAULTED is the ordinary
  end of an unpaid plan — and re-deriving ACTIVE from a non-zero balance
  silently cleared that, taking the family off the school's defaulted tile, the
  admin's defaulted count and the arrears escalation until the next sweep put
  them back. `statusAfterMigratedAmendment` makes only the two transitions the
  balance genuinely decides (settling to COMPLETED, reopening a COMPLETED plan
  to ACTIVE) and preserves everything else — the same rule `reversePayment`
  already applied as `reopened ? ACTIVE : before.paymentStatus`. It reads
  `paymentStatus` from inside the `FOR UPDATE` lock, alongside the balance, so
  a plan defaulted between the two reads is not decided against a stale value.

  And the **invite row is restated too**. It is what the school's list renders
  and what the amend form pre-fills as "Currently recorded" — the only place an
  owner reviews these numbers. Leaving it behind made a successful correction
  look like it had not applied, and a second attempt at the same figure was then
  refused as "the same as the recorded one", compared against a number that was
  no longer true. No history is lost: the before/after is on the audit row.

### 8. Migration is free

`MIGRATED_ENROLLMENT_PLATFORM_FEE_RATE` is zero. The 2.5%
([ADR 0002](./0002-fee-policy.md)) is collected once, inside the Paystack split
at first payment; migrated money never passes through that split, so there is
nothing to take a percentage of and no rail to take it on. The consequence is
deliberate: a migrated enrollment earns nothing for its whole life, priced in as
acquisition — the family is on a plan, and next term's enrollment is a normal
paid one.

## Consequences

- One new table, two new migrations (the enum values are isolated in their own
  file because `ALTER TYPE … ADD VALUE` cannot be used in the transaction that
  adds it), and RLS enabled on the new table as
  `20260731010000_enable_rls_public_schema` requires of every table in `public`.
- Delivery is the school's own. The API returns the link and pre-written text;
  the school copies it and sends it through whatever channel it already uses
  with that parent. No provider, no domain verification, no deliverability
  problem, and no assumption that the school and the family share one messaging
  app.

  An earlier cut returned a `wa.me` deep link as the primary action. It was
  removed rather than kept alongside the copy button, because a deep link
  addressed to a phone number reads as delivery TO that number and is nothing of
  the kind — `wa.me` opens a draft, and the sender can retarget it before
  pressing send. Presenting it as "Send on WhatsApp" implied a guarantee about
  who received the link that no part of this system makes, which matters more now
  that holding the link is the whole of the authorisation. If an automated
  transport is added later, the invite is already a token-and-link, so only the
  transport changes.
- The claim link is `…/#/claim-invite?token=…`, built and parsed by
  `enrollment-invites/claim-url.ts` and mirrored in the web client's
  `utils/claimUrl.ts`.

  The shape is forced twice over. The web app mounts `<HashRouter>`, so the
  in-app location lives inside the fragment: a link with its route in the real
  path reaches the SPA fallback, matches nothing and shows a blank screen.
  `NotificationsService.buildPushMessage` already states that rule for push
  click targets. Two earlier drafts of this link ignored it —
  `/claim-invite?token=…` and `/claim-invite#token=…` — and **neither could
  ever reach the claim screen**, which no test caught because every suite either
  stubbed the router or handed `MemoryRouter` a path directly.
  `Lopay/utils/claimUrl.hashrouter.test.tsx` now mounts the real router against
  a real `window.location` and closes that gap.

  It is also the private shape, which is why the token sits after the `#`
  rather than in a real query string: everything following a `#` is fragment
  and is never transmitted, so the token reaches no access log and no
  `Referer`. The router parsing part of that fragment as a query string is a
  routing detail; on the wire it is all fragment. Parsing deliberately refuses
  a real-query-string link rather than tolerating it, because such a link both
  fails to route and leaks the credential.
- The raw token is returned exactly once, at creation. A lost link is recovered
  by revoking and re-issuing, not by looking it up.
- `EnrollmentInviteStatus` has five states and the transitions are asserted in
  `invite-policy.spec.ts`; the concurrency guards, the partial index and the
  CHECK constraints are asserted against a real Postgres in
  `test/enrollment-invites.e2e-spec.ts`.
- The school supplies four facts and two choices — student, class, amount
  already paid, phone, cadence, start date. Everything else about the plan is
  derived: the fee from `ClassFee`, the end from the cadence, the platform fee
  from `MIGRATED_ENROLLMENT_PLATFORM_FEE_RATE`, the balance from
  `deriveMigratedPlan`. That is the property that keeps a migrated plan
  indistinguishable from a normally-enrolled one to every derivation that reads
  it.
- The one-live-invite-per-student rule is enforced twice, and deliberately not
  identically. The partial unique index compares exactly; `assertNoLiveInvite`
  compares case-insensitively, because the input is a human typing a child's
  name off a register twice and "Ada Lovelace" / "ada lovelace" is one child.
  Widening the service check only ever rejects more, so the index remains the
  guarantee. The DTO trims and collapses internal whitespace for the same
  reason, but does **not** fold case — a stored name should read the way its
  school wrote it.
- Authorisation on the four owner endpoints is proven against the database, not
  read off the session. `assertOwnsSchool` re-reads the school with
  `ownerId` and `deletedAt: null` for `create`, `list`, `revoke` and `amend`
  alike. The first draft did it on `create` only, with a comment explaining a
  threat — a session outliving a change of ownership — that the other three were
  equally exposed to; `amend` in particular restates money on a live plan. It is
  one method rather than a check on "the risky ones", because that judgement has
  to be re-made every time an endpoint is added, and it was already got wrong
  once. The cost is one indexed primary-key lookup.

- The claim screen no longer has a phone branch at all. It briefly grew one — an
  account with no number could not satisfy the old second factor, and the screen
  had been offering a button, taking the server's refusal, and rendering a
  sentence naming a page it gave no route to. Removing the factor (§4) removed
  the state, and the branch with it: an account without a phone is now
  indistinguishable from any other.

  What remains from that work is the token's lifetime. The held token is dropped
  when the claim is *finished* — claimed, disputed, or the invite turns out to be
  unclaimable — rather than the moment the parent signs in. Clearing on sign-in
  looked equivalent and was not: it discarded the token on the way INTO the
  screen, so any detour before confirming depended entirely on browser history.

- Adding a table made the e2e suites' database worth guarding. They take their
  connection from `.env` via `ConfigModule`, they are destructive, and on this
  project `.env` has held the deployed URL — so a stale `.env` meant a green run
  that passed by writing to production. `test/require-local-database.ts` is now
  the e2e `globalSetup`: it pins `DATABASE_URL` from the committed
  `test/.env.e2e`, then refuses any host that is not loopback.

- The guard on the e2e database was only half the exposure. `prisma migrate
  reset` and `db push` read the same `.env`, are far more destructive than any
  test suite, and were not covered — a developer told their test run is
  sandboxed has every reason to assume the CLI beside it is too. `npx prisma
  migrate deploy`, typed in this repo with the local Postgres running,
  connected to the production pooler; it is idempotent and applied nothing, but
  `migrate reset` one line later would not have been. `prisma.config.ts` is the
  one chokepoint every CLI invocation passes through, so the check lives there
  and refuses only the developer-destructive commands against a non-loopback
  host. `migrate deploy` is permanently absent from that list: the Dockerfile's
  `CMD` and CI both run it, and a guard that breaks a deploy is worse than the
  accident it prevents.

- Five `AuditAction` values were added, and the platform admin's audit screen
  maps actions to labels and colours with a fallback to the raw enum in neutral
  grey. That fallback does not look broken, so all five shipped rendering as
  though the screen had judged them unremarkable — including
  `MIGRATED_PAYMENT_AMENDED`, a school restating money on a plan a family is
  paying against. Mirrored tripwires (`src/audit/audit-actions.spec.ts` and
  `Lopay/pages/admin/AuditLogsScreen.test.tsx`) now assert the same list from
  both sides, because the enum and the screen live in different repositories and
  neither build can see the other — the same split, for the same reason, as
  `claim-url.ts` and `utils/claimUrl.ts`.

- **Not built: bulk issuing.** The premise of this ADR is a school arriving with
  a book of families part-way through paying, and the interface is a
  one-student-at-a-time form plus a manual send per family. That is a
  deliberate first cut — the invite is already a token-and-link, so a CSV import
  adds a parser and a batch endpoint without changing the model — but it is a
  real limit and it is recorded here rather than discovered by the first school
  with two hundred students.
