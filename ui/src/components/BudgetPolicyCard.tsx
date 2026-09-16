import { useEffect, useState } from "react";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { SUBSCRIPTION_BUDGET_WINDOW_DURATION_MS, isSubscriptionBudgetWindowKind } from "@paperclipai/shared";
import { AlertTriangle, HelpCircle, Hourglass, PauseCircle, ShieldAlert, Wallet } from "lucide-react";
import { cn, formatCents, formatDurationMs, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

function centsInputValue(value: number) {
  return (value / 100).toFixed(2);
}

function parseDollarInput(value: string) {
  const normalized = value.trim();
  if (normalized.length === 0) return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function parsePercentInput(value: string) {
  const normalized = value.trim();
  if (normalized.length === 0) return 0;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) return null;
  return parsed;
}

export function isSubscriptionBudget(summary: Pick<BudgetPolicySummary, "metric">) {
  return summary.metric === "subscription_percent";
}

function formatPercent(value: number) {
  // Released shares are fractional; a tenth of a percent is plenty here.
  return `${Math.round(value * 10) / 10}%`;
}

/**
 * How fast a progressive limit is released, in the unit an operator thinks
 * in: per hour for the session window, per day for the week.
 */
export function progressiveReleaseRate(windowKind: BudgetPolicySummary["windowKind"], amount: number) {
  if (!isSubscriptionBudgetWindowKind(windowKind) || amount <= 0) return null;
  const perHour = windowKind === "provider_session";
  const unitMs = (perHour ? 1 : 24) * 60 * 60 * 1000;
  const perUnit = (amount * unitMs) / SUBSCRIPTION_BUDGET_WINDOW_DURATION_MS[windowKind];
  return `${formatPercent(perUnit)} per ${perHour ? "hour" : "day"}`;
}

function releaseCountdown(releaseAt: string) {
  const ms = new Date(releaseAt).getTime() - Date.now();
  return Number.isFinite(ms) && ms > 0 ? formatDurationMs(ms) : "moments";
}

export function windowLabel(windowKind: BudgetPolicySummary["windowKind"]) {
  switch (windowKind) {
    case "lifetime":
      return "Lifetime budget";
    case "provider_session":
      return "Provider session window";
    case "provider_week":
      return "Provider weekly window";
    default:
      return "Monthly UTC budget";
  }
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

/**
 * Usage bar. In window mode the track is the whole provider window (0-100%),
 * the fill is the observed usage, a marker sits at the configured limit, and
 * any usage past the limit is hatched so "remaining" reads as the gap between
 * the fill and the marker. A progressive limit adds a second indicator: the
 * released share so far is tinted on the track and closed by a green marker,
 * and usage past it but under the limit is hatched in the warning tone,
 * because runs wait there for the next release rather than the reset. Both
 * markers stand taller than the track and carry a halo in the card colour,
 * so they read over any fill, including a red one at the limit. Money budgets
 * have no natural ceiling, so their bar stays a plain utilization-of-budget
 * fill.
 */
function BudgetUsageBar({
  usedPercent,
  limitPercent,
  releasedPercent,
  status,
  unavailable,
  neutral,
  held,
  className,
}: {
  /** Fill, as a percent of the track. */
  usedPercent: number;
  /** Limit marker position, or null for a plain utilization bar. */
  limitPercent: number | null;
  /** Released-share marker position for a progressive limit, or null. */
  releasedPercent: number | null;
  status: BudgetPolicySummary["status"];
  unavailable: boolean;
  /** No limit is configured, so the fill carries no status meaning. */
  neutral: boolean;
  /** Usage is unknown under a limit, so the gate is holding new runs. */
  held: boolean;
  className?: string;
}) {
  const used = unavailable ? 0 : clampPercent(usedPercent);
  const limit = limitPercent == null ? null : clampPercent(limitPercent);
  // The released share only needs its own indicator while it is below the
  // limit; once fully released the two coincide and the limit marker suffices.
  const released =
    limit == null || releasedPercent == null || clampPercent(releasedPercent) >= limit
      ? null
      : clampPercent(releasedPercent);
  const solidEnd = released ?? limit;
  const withinLimit = solidEnd == null ? used : Math.min(used, solidEnd);
  const overReleased = released == null || limit == null ? 0 : Math.max(0, Math.min(used, limit) - released);
  const overLimit = limit == null ? 0 : Math.max(0, used - limit);
  const fillClassName = neutral
    ? "bg-muted-foreground/50"
    : status === "hard_stop"
      ? "bg-(--status-task-blocked)"
      : status === "warning"
        ? "bg-(--status-task-todo)"
        : "bg-(--status-task-done)";
  const label = unavailable
    ? limit != null && limit > 0
      ? `Window usage unknown, limit ${Math.round(limit)}%; new runs are held`
      : "Budget utilization unknown"
    : limit == null
      ? `Budget utilization: ${Math.round(used)}% used`
      : `Window usage: ${Math.round(used)}% used, limit ${Math.round(limit)}%` +
        (released != null ? `, ${Math.round(released)}% released so far` : "");
  // No overflow clipping on the track: the markers stand proud of it, so the
  // overlays round their own outer corners instead.
  return (
    <div className={cn("relative h-2 rounded-full", className)}>
      {released != null ? (
        <div
          data-testid="budget-released-track"
          aria-hidden
          className="absolute inset-y-0 left-0 rounded-l-full bg-(--status-task-done)/25"
          style={{ width: `${released}%` }}
        />
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={Math.round(used)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        // Positioned so it paints over the released tint but under the overlays below.
        className={cn("relative h-full rounded-full transition-(--tp-width-background-color) duration-200", fillClassName)}
        style={{ width: `${withinLimit}%` }}
      />
      {held ? (
        <div
          data-testid="budget-usage-held"
          aria-hidden
          className="absolute inset-0 rounded-full bg-(--status-task-blocked)/25"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, var(--status-task-blocked) 0 2px, transparent 2px 5px)",
          }}
        />
      ) : null}
      {overReleased > 0 ? (
        <div
          data-testid="budget-over-released"
          aria-hidden
          className={cn("absolute inset-y-0 bg-(--status-task-todo)/40", released === 0 && "rounded-l-full")}
          style={{
            left: `${released}%`,
            width: `${overReleased}%`,
            backgroundImage:
              "repeating-linear-gradient(135deg, var(--status-task-todo) 0 2px, transparent 2px 5px)",
          }}
        />
      ) : null}
      {overLimit > 0 ? (
        <div
          data-testid="budget-over-limit"
          aria-hidden
          className={cn("absolute inset-y-0 bg-(--status-task-blocked)/40", used >= 100 && "rounded-r-full")}
          style={{
            left: `${limit}%`,
            width: `${overLimit}%`,
            backgroundImage:
              "repeating-linear-gradient(135deg, var(--status-task-blocked) 0 2px, transparent 2px 5px)",
          }}
        />
      ) : null}
      {released != null ? (
        <div
          data-testid="budget-released-marker"
          aria-hidden
          title={`Released ${Math.round(released)}% so far`}
          className="absolute -inset-y-1 w-0.5 rounded-full bg-(--status-task-done) ring-1 ring-background"
          style={{ left: `calc(${released}% - 1px)` }}
        />
      ) : null}
      {limit != null && limit > 0 ? (
        <div
          data-testid="budget-limit-marker"
          aria-hidden
          title={`Limit ${Math.round(limit)}%`}
          className="absolute -inset-y-1.5 w-0.5 rounded-full bg-foreground ring-1 ring-background"
          style={{ left: `calc(${limit}% - 1px)` }}
        />
      ) : null}
    </div>
  );
}

/** Names the bar's markers, so nobody has to hover a two-pixel tick to learn what it is. */
function BudgetMarkerLegend({ limitPercent, releasedPercent }: { limitPercent: number; releasedPercent: number | null }) {
  return (
    <div data-testid="budget-marker-legend" className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
      {releasedPercent != null && releasedPercent < limitPercent ? (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-0.5 rounded-full bg-(--status-task-done)" />
          Released {formatPercent(releasedPercent)} so far
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-3.5 w-0.5 rounded-full bg-foreground" />
        Limit {formatPercent(limitPercent)}
      </span>
    </div>
  );
}

function statusTone(
  status: BudgetPolicySummary["status"],
  usageUnavailable: boolean,
  usageHeld: boolean,
  releaseWait: boolean,
) {
  if (usageHeld) return "text-red-700 dark:text-red-300 border-red-500/30 bg-red-500/10";
  if (usageUnavailable) return "text-muted-foreground border-border/70 bg-muted/40";
  if (status === "hard_stop") return "text-red-700 dark:text-red-300 border-red-500/30 bg-red-500/10";
  if (status === "warning" || releaseWait) return "text-amber-700 dark:text-amber-200 border-amber-500/30 bg-amber-500/10";
  return "text-emerald-700 dark:text-emerald-200 border-emerald-500/30 bg-emerald-500/10";
}

export function BudgetPolicyCard({
  summary,
  onSave,
  isSaving,
  compact = false,
  variant = "card",
}: {
  summary: BudgetPolicySummary;
  /**
   * Saves the drafted amount (cents or percent). `progressive` is the drafted
   * release mode; it is only ever true for a subscription budget.
   */
  onSave?: (amount: number, options: { progressive: boolean }) => void;
  isSaving?: boolean;
  compact?: boolean;
  variant?: "card" | "plain";
}) {
  const percentMode = isSubscriptionBudget(summary);
  const toInputValue = percentMode ? String : centsInputValue;
  const formatAmount = percentMode ? formatPercent : formatCents;
  const [draftBudget, setDraftBudget] = useState(toInputValue(summary.amount));
  const savedProgressive = percentMode && summary.progressive === true;
  const [draftProgressive, setDraftProgressive] = useState(savedProgressive);

  useEffect(() => {
    setDraftBudget(toInputValue(summary.amount));
  }, [summary.amount, toInputValue]);
  useEffect(() => {
    setDraftProgressive(savedProgressive);
  }, [savedProgressive]);

  const parsedDraft = percentMode ? parsePercentInput(draftBudget) : parseDollarInput(draftBudget);
  const amountChanged = typeof parsedDraft === "number" && parsedDraft !== summary.amount;
  // A release-mode change on its own only matters with a limit to release.
  const progressiveChanged = draftProgressive !== savedProgressive && typeof parsedDraft === "number" && parsedDraft > 0;
  const canSave = Boolean(onSave) && (amountChanged || progressiveChanged);
  // The provider did not report this window: say so, never show a healthy 0%.
  const usageUnavailable = percentMode && summary.usageUnavailable === true;
  // The latest provider read failed and the usage comes from the last good
  // read: still a measurement, so keep the value and say how old it is.
  const usageStale = percentMode && !usageUnavailable && summary.usageStale === true;
  // A limit that cannot be checked holds new runs (the gate fails closed, and
  // a stale read never clears a run), so the card reads as "held" rather than
  // merely "unknown" or "healthy". Without a limit nothing is held.
  const usageHeld = (usageUnavailable || usageStale) && summary.amount > 0;
  const overLimitBy = percentMode && summary.amount > 0 ? summary.observedAmount - summary.amount : 0;
  // A progressive limit is only partly in force: the released share paces
  // what may be used right now, and usage at or ahead of it (but under the
  // full limit) means the gate holds new runs until the next release, which
  // is the normal rhythm of a progressive budget rather than an alarm.
  const progressive = savedProgressive && summary.amount > 0;
  const releasedAmount = progressive ? Math.min(summary.releasedAmount ?? summary.amount, summary.amount) : summary.amount;
  const releaseWait =
    progressive &&
    !usageUnavailable &&
    !usageStale &&
    summary.observedAmount > 0 &&
    summary.observedAmount >= releasedAmount &&
    summary.observedAmount < summary.amount;
  const StatusIcon = usageHeld
    ? PauseCircle
    : usageUnavailable
      ? HelpCircle
      : releaseWait
        ? Hourglass
        : summary.status === "hard_stop"
          ? ShieldAlert
          : summary.status === "warning"
            ? AlertTriangle
            : Wallet;
  const statusLabel = summary.paused
    ? "Paused"
    : usageHeld
      ? "Runs held"
      : usageUnavailable
        ? "Unknown"
        : releaseWait
          ? "Waiting for release"
          : summary.status === "warning"
            ? "Warning"
            : summary.status === "hard_stop"
              ? "Hard stop"
              : "Healthy";
  const observedValue = usageUnavailable ? "Unavailable" : formatAmount(summary.observedAmount);
  const observedBase = summary.amount > 0 ? `${summary.utilizationPercent}% of limit` : "No cap configured";
  const observedCaption = usageUnavailable
    ? usageHeld
      ? "Provider did not report this window · new runs wait until it does"
      : "Provider did not report this window"
    : usageStale
      ? `${observedBase} · as of ${summary.usageObservedAt ? relativeTime(summary.usageObservedAt) : "an earlier read"}, latest read failed` +
        (usageHeld ? "; new runs wait for a fresh read" : "")
      : observedBase;
  const remainingValue = usageUnavailable
    ? "Unknown"
    : summary.amount > 0
      ? overLimitBy > 0
        ? `Over limit by ${formatAmount(overLimitBy)}`
        : releaseWait
          ? `Ahead of release by ${formatAmount(summary.observedAmount - releasedAmount)}` +
            (summary.releaseAt ? ` · more in ${releaseCountdown(summary.releaseAt)}` : "")
          : formatAmount(summary.remainingAmount)
      : "Unlimited";
  const releaseRate = progressiveReleaseRate(summary.windowKind, summary.amount);
  const budgetCaption = percentMode
    ? progressive
      ? `Progressive release${releaseRate ? ` · ${releaseRate}` : ""} · ` +
        (summary.releaseWindowUnknown
          ? "reset time unknown, full limit in force"
          : releasedAmount >= summary.amount
            ? "fully released"
            : `${formatPercent(releasedAmount)} released so far`)
      : "New runs wait for the window reset above the limit"
    : `Soft alert at ${summary.warnPercent}%${summary.paused && summary.pauseReason ? ` · ${summary.pauseReason} pause` : ""}`;
  const isPlain = variant === "plain";

  const observedBudgetGrid = isPlain ? (
    <div className="grid gap-6 sm:grid-cols-2">
      <div>
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">Observed</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">{observedValue}</div>
        <div className="mt-1 text-xs text-muted-foreground">{observedCaption}</div>
      </div>
      <div>
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">Budget</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">
          {summary.amount > 0 ? formatAmount(summary.amount) : "Disabled"}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{budgetCaption}</div>
      </div>
    </div>
  ) : (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-border/70 bg-black/[0.18] px-4 py-3">
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">Observed</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">{observedValue}</div>
        <div className="mt-1 text-xs text-muted-foreground">{observedCaption}</div>
      </div>
      <div className="rounded-xl border border-border/70 bg-black/[0.18] px-4 py-3">
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">Budget</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">
          {summary.amount > 0 ? formatAmount(summary.amount) : "Disabled"}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{budgetCaption}</div>
      </div>
    </div>
  );

  const progressSection = (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Remaining</span>
        <span>{remainingValue}</span>
      </div>
      {percentMode ? (
        <BudgetUsageBar
          usedPercent={summary.observedAmount}
          limitPercent={summary.amount > 0 ? summary.amount : null}
          releasedPercent={progressive ? releasedAmount : null}
          status={releaseWait ? "warning" : summary.status}
          unavailable={usageUnavailable}
          neutral={summary.amount <= 0}
          held={usageHeld}
          className={isPlain ? "bg-border/70" : "bg-muted/70"}
        />
      ) : (
        <BudgetUsageBar
          usedPercent={summary.amount > 0 ? summary.utilizationPercent : 0}
          limitPercent={null}
          releasedPercent={null}
          status={summary.status}
          unavailable={false}
          neutral={false}
          held={false}
          className={isPlain ? "bg-border/70" : "bg-muted/70"}
        />
      )}
      {percentMode && summary.amount > 0 ? (
        <BudgetMarkerLegend limitPercent={summary.amount} releasedPercent={progressive ? releasedAmount : null} />
      ) : null}
    </div>
  );

  const pausedPane = summary.paused ? (
    <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-900 dark:text-red-100">
      <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        {summary.scopeType === "project"
          ? "Execution is paused for this project until the budget is raised or the incident is dismissed."
          : "Heartbeats are paused for this scope until the budget is raised or the incident is dismissed."}
      </div>
    </div>
  ) : null;

  // The rate previews the drafted limit so the operator sees what "10% a
  // day" means before saving; without a limit there is nothing to pace.
  const draftRate = progressiveReleaseRate(
    summary.windowKind,
    typeof parsedDraft === "number" && parsedDraft > 0 ? parsedDraft : summary.amount,
  );
  const progressiveRow = percentMode ? (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">Progressive release</div>
        <div className="text-xs text-muted-foreground">
          {draftProgressive
            ? `Releases the limit evenly over the window${draftRate ? `, about ${draftRate}` : ""}`
            : "Release the limit evenly over the window instead of all at once"}
        </div>
      </div>
      <ToggleSwitch
        data-testid="budget-progressive-toggle"
        aria-label="Progressive release"
        checked={draftProgressive}
        onCheckedChange={setDraftProgressive}
        disabled={isSaving}
      />
    </div>
  ) : null;

  const saveSection = onSave ? (
    <div className={cn("space-y-3", isPlain ? "" : "rounded-xl border border-border/70 bg-background/50 p-3")}>
      {progressiveRow}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
            {percentMode ? "Limit (% of window)" : "Budget (USD)"}
          </label>
          <Input
            value={draftBudget}
            onChange={(event) => setDraftBudget(event.target.value)}
            className="mt-2"
            inputMode={percentMode ? "numeric" : "decimal"}
            placeholder={percentMode ? "0" : "0.00"}
          />
        </div>
        <Button
          onClick={() => {
            if (typeof parsedDraft === "number" && onSave) {
              onSave(parsedDraft, { progressive: percentMode && draftProgressive });
            }
          }}
          disabled={!canSave || isSaving || parsedDraft === null}
        >
          {isSaving ? "Saving..." : summary.amount > 0 ? (percentMode ? "Update limit" : "Update budget") : (percentMode ? "Set limit" : "Set budget")}
        </Button>
      </div>
    </div>
  ) : null;

  if (isPlain) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
              {summary.scopeType}
            </div>
            <div className="mt-2 text-xl font-semibold">{summary.scopeName}</div>
            <div className="mt-2 text-sm text-muted-foreground">{windowLabel(summary.windowKind)}</div>
          </div>
          <div
            className={cn(
              "inline-flex items-center gap-2 text-(length:--text-micro) uppercase tracking-(--tracking-caps)",
              usageHeld || summary.status === "hard_stop"
                ? "text-red-700 dark:text-red-300"
                : summary.status === "warning" || releaseWait
                  ? "text-amber-800 dark:text-amber-200"
                  : "text-muted-foreground",
            )}
          >
            <StatusIcon className="h-3.5 w-3.5" />
            {statusLabel}
          </div>
        </div>

        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {parsedDraft === null ? (
          <p className="text-xs text-destructive">
            {percentMode ? "Enter a whole number between 0 and 100." : "Enter a valid non-negative dollar amount."}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <Card className={cn("overflow-hidden border-border/70 bg-card/80", compact ? "" : "shadow-(--shadow-extract-2)")}>
      <CardHeader className={cn("gap-3", compact ? "px-4 pt-4 pb-2" : "px-5 pt-5 pb-3")}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
              {summary.scopeType}
            </div>
            <CardTitle className="mt-1 text-base">{summary.scopeName}</CardTitle>
            <CardDescription className="mt-1">{windowLabel(summary.windowKind)}</CardDescription>
          </div>
          <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-(length:--text-micro) uppercase tracking-(--tracking-caps)", statusTone(summary.status, usageUnavailable, usageHeld, releaseWait))}>
            <StatusIcon className="h-3.5 w-3.5" />
            {statusLabel}
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn("space-y-4", compact ? "px-4 pb-4 pt-0" : "px-5 pb-5 pt-0")}>
        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {parsedDraft === null ? (
          <p className="text-xs text-destructive">
            {percentMode ? "Enter a whole number between 0 and 100." : "Enter a valid non-negative dollar amount."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
