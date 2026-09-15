# Progressive Subscription Budgets

## Context

A `subscription_percent` budget policy (see
[subscription window budgets](2026-09-13-subscription-window-budgets.md)) is a
ceiling: new runs are deferred once the provider window is at or above N%
used, and nothing stops the agents from spending the whole N% in the first
hour of the window. An operator who wants "leave me headroom all week", not
"leave me headroom until the agents have had theirs", has to babysit the limit
by hand.

## Model

`budget_policies` gains one boolean, `progressive` (default false), that only
means something on a `subscription_percent` policy; the validator rejects it on
money budgets and the service stores `false` for them regardless of input.

When it is set, the limit is *released* linearly over the provider window
instead of being available in full from the start:

    released(t) = amount × clamp((t − windowStart) / windowLength, 0, 1)

so 70% of a week releases 10% a day and 100% of a session releases 20% an
hour. The provider only reports the window's reset time, so `windowStart` is
derived as the reset minus the nominal window length
(`SUBSCRIPTION_BUDGET_WINDOW_DURATION_MS`: 5 hours for the session, 7 days for
the week), the same derivation the summaries already use to render window
bounds. The release is continuous rather than stepped by the hour or day: a
step would only add an artificial wait for the top of the hour.

Without a usable reset time (the Claude CLI fallback reports none, and a reset
already in the past means the window has rolled) the window position is
unknown, so the full `amount` applies. The configured ceiling still holds and
only the smoothing is lost, which beats holding every run until a reset is
reported.

## Enforcement

The gate compares usage with the released share instead of the full limit,
through one pure evaluation (`evaluateSubscriptionRelease`) that the budget
summaries also run, so the card and the dispatcher agree on what is held and
until when.

- Usage under the released share proceeds.
- Usage at or ahead of the released share, but under the full limit, is
  deferred to the moment the release catches up with it,
  `windowStart + used / amount × windowLength`, plus the usual 30-second
  margin. That is earlier than the reset, so the run does not wait out the
  window: it waits out its share. The sawtooth of "run, wait for release, run"
  is the intended behaviour and is what spreads the budget across the window.
- Usage at or above the full limit waits for the reset as a fixed limit does.
- Usage of 0 is never held: nothing has been consumed to pace, even at the
  very start of a window when nothing has been released either.
- The stale-read rule applies to the released share: a stale value under it
  cannot clear the run and holds for the unknown-usage re-check, while a stale
  value ahead of it defers to the catch-up time, which only tightens the gate
  because usage only grows within a window.

The deferral is the ordinary `subscription_window_wait` scheduled retry. The
wait summary on the run carries `progressive`, `releasedPercent` and
`releaseAt`, and the run event reads "Deferred until more of the progressive
subscription limit is released" when the wait is for a release rather than the
reset. Timer heartbeats are skipped, the wait bound applies, and no incident,
pause, or approval is created, exactly as for a fixed limit.

## UI

The subscription budget card gains a **Progressive release** toggle next to
the limit input. The toggle is part of the draft: "Set limit" / "Update limit"
saves the amount and the release mode together, and the toggle's caption
previews the drafted rate ("about 10% per day") before saving. An amount-only
update through the API keeps the stored mode; only an explicit `false` clears
it.

The usage bar shows two indicators for a progressive limit. The limit marker
stays where it was. The released share so far is tinted on the track and
closed by a lighter marker, so "Remaining" reads as the gap between the fill
and the release marker. Usage past the release marker but under the limit is
hatched in the warning tone and the card reads **Waiting for release** with the
time until the next release ("more in 2h 10m"); usage past the limit is hatched
in the blocked tone and reads "Over limit" as before. Once the whole limit is
released the two indicators coincide and the card looks like a fixed limit
again. The Budget cell's caption names the mode and the rate ("Progressive
release · 10% per day · 30% released so far").

`BudgetPolicySummary` carries `progressive`, `releasedAmount` (the part of
`amount` in force right now; `remainingAmount` is measured against it),
`releaseAt` (set only while usage is ahead of the release) and
`releaseWindowUnknown` (the provider reported no usable reset, so the full
limit is in force; the card says "reset time unknown, full limit in force"
rather than "fully released"). `status` keeps
describing the full limit, so "Warning" still means "near the ceiling".

## Follow-ups (not in this change)

- The Claude CLI `/usage` fallback reports the reset only as display text
  ("Resets Sep 20 at 3:30pm") and leaves `resetsAt` null, so on a CLI-only
  host a progressive limit currently degrades to its full amount. Parsing that
  text into `resetsAt` in the claude-local adapter would make the release
  schedule work there too.
- Agent and project scoped subscription policies still have no UI; they take
  `progressive` through the policies API like any other field.
- A release floor or a stepped schedule, if the continuous release turns out to
  hold the first runs of a window too eagerly in practice.
