# Subscription Window Budgets

## Context

Paperclip has two separate views of provider consumption:

- `cost_events` and `budget_policies` model **money**. A `billed_cents` policy
  sums cost events over a calendar month or the scope lifetime. Crossing the
  limit opens a budget incident, pauses the scope, cancels its runs, and asks
  the Board to raise the budget.
- Provider quota windows model **subscription usage**. The Claude and Codex
  adapters report the provider's own rate-limit windows (a rolling session
  window and a rolling weekly window) as a percent used plus a reset time.
  Subscription runs record `subscription_included` cost events at 0 cents, so
  they never move a money budget.

Operators on a subscription plan have no way to say "leave headroom in my
session window for interactive use" or "stop burning the weekly window on
low-priority agents". The money budget cannot express it, and a money-style
hard stop would be the wrong tool anyway: a subscription window resets on its
own, so pausing the scope and asking a human to "raise the budget" would be
noise that also needs a human to undo.

## Model

`budget_policies` gains one metric and two window kinds:

| Field        | New values                              |
| ------------ | --------------------------------------- |
| `metric`     | `subscription_percent`                  |
| `window_kind`| `provider_session`, `provider_week`     |

- `amount` is a whole percent (0–100) of the provider window.
- `provider_session` reads the provider's `five_hour` window and
  `provider_week` reads its `seven_day` window. Windows are matched by a stable
  `key` on `QuotaWindow`, never by display label.
- Scope semantics are unchanged: a company policy applies to every agent, an
  agent policy to that agent, a project policy to runs in that project. Each
  agent is measured against its own adapter's provider.
- Two policies on the same scope (session and week) combine as OR: whichever
  window is saturated defers the run, and the wait ends at the latest reset.

No schema migration is needed; both columns are free text.

## Enforcement: defer, never pause

Subscription policies are enforced in exactly one place, `claimQueuedRun`, the
last step before adapter invocation. They do not participate in
`getInvocationBlock`, incidents, approvals, or scope pausing.

When a queued run's provider window is at or above the limit:

- **Timer heartbeats** are skipped quietly (`subscription_window_skipped`),
  exactly like the daily cap: the wake is marked skipped and the next interval
  tries again.
- **Every other wake** keeps its run. The run moves to `scheduled_retry` with
  `scheduled_retry_reason = subscription_window_wait` and
  `scheduled_retry_at = resets_at + 30s` (or a default wait when the provider
  reports no reset). The ordinary due-retry loop promotes it back to `queued`,
  and the gate re-evaluates on the next claim. If the window is still
  saturated the run is deferred again with an incremented attempt.
- The issue keeps its status and assignee, the wake stays queued, and no
  comment, incident, approval, or recovery action is written.

The gate **fails open**: when the quota snapshot is unavailable or the provider
result is not ok, runs proceed. The provider's real limit still applies and is
handled by the existing `provider_quota` recovery.

Only a broken assumption reaches a human: a run that has been waiting for
longer than `PAPERCLIP_SUBSCRIPTION_WINDOW_WAIT_MAX_MS` (default 8 days, one
full weekly window plus a day of margin) since its first consecutive deferral
is cancelled with `subscription_window_wait_exhausted` through the same
pre-invocation path as the daily cap: the wake is settled and immediate
recovery is suppressed, because recovery would only re-queue the work straight
back into this gate. The cancelled run and its idle issue then surface through
the ordinary stale-work checks. The bound is a duration rather than a count of
deferrals: the Claude CLI fallback reports no reset time, so a saturated
weekly window is re-checked every `PAPERCLIP_SUBSCRIPTION_WINDOW_WAIT_DEFAULT_MS`
(default 15 minutes) for up to a week, which a small deferral count would
exhaust in hours. Only deferrals by this gate count toward the bound; a run
promoted after workspace-busy, transient, or continuation retries starts a
fresh wait. A reported reset later than the deadline is clamped to it, so a
bogus far-future reset cannot hold a run past the bound either.

## Quota snapshot

`readQuotaSnapshot()` memoizes `fetchAllQuotaWindows()` process-wide with a
TTL (`PAPERCLIP_QUOTA_SNAPSHOT_TTL_MS`, default 60s) and shares one in-flight
fetch between concurrent callers. Provider usage endpoints are rate limited and
the Claude CLI fallback runs a terminal probe, so enforcement never fetches per
dispatch. The same snapshot feeds the budget overview so a
`subscription_percent` policy summary shows live percent used and the
provider's reset time as its window end.

## UI

The Costs → Budgets tab gains a "Subscription usage limits" section with one
card per window (session, week) for the organization scope. Cards for windows
without a policy are seeded from the live quota snapshot so the operator sees
current usage before choosing a limit. `BudgetPolicyCard` renders
`subscription_percent` policies in percent. When no provider reported the
window (quota fetch failed, window missing, or no utilization) the summary
carries `usageUnavailable` and the card shows the usage as unavailable with an
"Unknown" status instead of a healthy 0%. Agent and project scoped
subscription policies are created through the existing policies API.

## Follow-ups (not in this change)

- Soft-threshold notifications and attention items for subscription policies,
  reusing `budget_incidents` keyed on the provider window start.
- Per-model windows (`seven_day_sonnet`, `seven_day_opus`).
- Account-aware quota reads when agents use distinct provider logins.
