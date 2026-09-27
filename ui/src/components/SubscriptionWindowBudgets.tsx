import { useState } from "react";
import type { BudgetPolicySummary, SubscriptionBudgetProvider, SubscriptionBudgetWindowKind } from "@paperclipai/shared";
import { CheckCircle2, Hourglass, PauseCircle, Plus } from "lucide-react";
import { BudgetMarkerLegend, BudgetUsageBar, progressiveReleaseRate } from "./BudgetPolicyCard";
import { cn, formatDurationMs, relativeTime } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

export type SubscriptionRuleInput = {
  provider: SubscriptionBudgetProvider;
  windowKind: SubscriptionBudgetWindowKind;
  amount: number;
  progressive: boolean;
};

const providerName = (provider: string | null | undefined) => provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : "Unknown provider";
const windowName = (window: string) => window === "provider_week" ? "Weekly (7 days)" : "Session (5 hours)";
const percent = (value: number) => `${Number(value.toFixed(1))}%`;
const countdown = (value: string | Date) => `in ${formatDurationMs(Math.max(0, new Date(value).getTime() - Date.now()))}`;
const dateLabel = (value: string | Date | null | undefined) => value ? new Date(value).toLocaleString() : "Unknown";

export function SubscriptionWindowBudgets({ policies, onSave, onDelete }: {
  policies: BudgetPolicySummary[];
  onSave: (input: SubscriptionRuleInput, policyId?: string) => Promise<unknown>;
  onDelete: (policyId: string) => Promise<unknown>;
}) {
  const rows = policies.filter((policy) => policy.scopeType === "company" && policy.metric === "subscription_percent")
    .toSorted((a, b) => (a.provider ?? "").localeCompare(b.provider ?? "") || a.windowKind.localeCompare(b.windowKind));
  const [editing, setEditing] = useState<BudgetPolicySummary | "new" | null>(null);
  const [deleting, setDeleting] = useState<BudgetPolicySummary | null>(null);
  const [provider, setProvider] = useState<SubscriptionBudgetProvider>("openai");
  const [windowKind, setWindowKind] = useState<SubscriptionBudgetWindowKind>("provider_week");
  const [amount, setAmount] = useState("100");
  const [progressive, setProgressive] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editingId = editing && editing !== "new" ? editing.policyId : undefined;
  const duplicate = rows.some((row) => row.policyId !== editingId && row.provider === provider && row.windowKind === windowKind);
  const validAmount = /^\d+$/.test(amount) && Number(amount) >= 1 && Number(amount) <= 100;

  function openEditor(rule: BudgetPolicySummary | "new") {
    const available = (["openai", "anthropic"] as const).flatMap((p) =>
      (["provider_week", "provider_session"] as const).map((w) => ({ provider: p, windowKind: w })))
      .find((candidate) => !rows.some((row) => row.provider === candidate.provider && row.windowKind === candidate.windowKind));
    setProvider(rule === "new" ? available?.provider ?? "openai" : rule.provider as SubscriptionBudgetProvider);
    setWindowKind(rule === "new" ? available?.windowKind ?? "provider_week" : rule.windowKind as SubscriptionBudgetWindowKind);
    setAmount(rule === "new" ? "100" : String(rule.amount || 100));
    setProgressive(rule === "new" ? true : rule.progressive === true);
    setError(null);
    setEditing(rule);
  }

  async function save() {
    if (!validAmount || duplicate || pending) return;
    setPending(true);
    setError(null);
    try {
      await onSave({ provider, windowKind, amount: Number(amount), progressive }, editingId);
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the rule. Try again.");
    } finally { setPending(false); }
  }

  async function remove() {
    if (!deleting || pending) return;
    setPending(true);
    setError(null);
    try {
      await onDelete(deleting.policyId);
      setDeleting(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the rule. Try again.");
    } finally { setPending(false); }
  }

  return (
    <section className="space-y-3" aria-label="Subscription budget rules">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Subscription budget rules</h2>
          <p className="text-sm text-muted-foreground">Set independent limits for each provider and window. Progressive rules release the limit evenly over that provider’s window; fixed rules make the full limit available immediately.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => openEditor("new")} disabled={pending || rows.length >= 4}><Plus />Add rule</Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-border" role="table" aria-label="Provider budget rules">
        <div role="row" className="hidden grid-cols-12 gap-6 border-b border-border bg-muted/30 px-5 py-3 text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground lg:grid">
          <div role="columnheader" className="col-span-2">Provider / window</div>
          <div role="columnheader" className="col-span-6">Usage &amp; release</div>
          <div role="columnheader" className="col-span-3">Availability</div>
          <div role="columnheader" className="col-span-1 text-right">Actions</div>
        </div>
        <div role="rowgroup" className="divide-y divide-border">
          {rows.map((rule) => {
            const active = rule.isActive && rule.amount > 0;
            const released = rule.releasedAmount ?? rule.amount;
            const heldForRelease = active && rule.progressive && !rule.usageUnavailable && rule.observedAmount > 0 && rule.observedAmount >= released && rule.observedAmount < rule.amount;
            const status = !active ? "Disabled" : rule.usageUnavailable ? "Usage unavailable" : rule.usageHeld ? "Waiting for fresh usage" : rule.observedAmount >= rule.amount ? "Limit reached" : heldForRelease ? "Waiting for release" : "Available";
            const held = active && (rule.usageHeld || rule.usageUnavailable || heldForRelease || rule.observedAmount >= rule.amount);
            const StatusIcon = heldForRelease ? Hourglass : held ? PauseCircle : CheckCircle2;
            const remaining = rule.usageUnavailable ? "Allowance unknown" : !active ? "No limit configured" : heldForRelease ? `${percent(rule.observedAmount - released)} ahead of release` : `${percent(rule.remainingAmount)} available now`;
            return <div role="row" key={rule.policyId} className="grid grid-cols-1 items-center gap-5 bg-card px-5 py-5 lg:grid-cols-12 lg:gap-6">
              <div role="cell" className="space-y-1 lg:col-span-2">
                <div className="text-lg font-semibold tracking-tight">{providerName(rule.provider)}</div>
                <div className="text-sm text-muted-foreground">{windowName(rule.windowKind)}</div>
                <div className="pt-1 text-xs font-medium">{rule.progressive ? "Progressive release" : "Fixed limit"}</div>
              </div>
              <div role="cell" className="space-y-4 lg:col-span-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">Observed</div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{rule.usageUnavailable ? "Unknown" : percent(rule.observedAmount)}<span className="ml-2 text-xs font-normal tracking-normal text-muted-foreground">{rule.usageStale ? "last known usage" : "used"}</span></div>
                  </div>
                  <div className="text-right">
                    <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">Budget</div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{active ? percent(rule.amount) : "Disabled"}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{active && rule.progressive ? progressiveReleaseRate(rule.windowKind, rule.amount) : "Full limit available immediately"}</div>
                  </div>
                </div>
                <div className="space-y-3">
                  <BudgetUsageBar usedPercent={rule.observedAmount} limitPercent={active ? rule.amount : null} releasedPercent={active && rule.progressive ? released : null} status={heldForRelease ? "warning" : rule.status} unavailable={rule.usageUnavailable === true} neutral={!active} held={active && rule.usageHeld === true} className="bg-muted/70" />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {active && <BudgetMarkerLegend limitPercent={rule.amount} releasedPercent={rule.progressive && !rule.releaseWindowUnknown ? released : null} />}
                    <span className="text-xs text-muted-foreground">{rule.releaseWindowUnknown ? "Reset unknown · full limit in force" : remaining}</span>
                  </div>
                </div>
              </div>
              <div role="cell" className="space-y-2 lg:col-span-3">
                <div className={cn("flex items-center gap-2 text-sm font-medium", held ? "text-(--status-task-todo)" : active ? "text-(--status-task-done)" : "text-muted-foreground")}><StatusIcon className="size-4 shrink-0" />{status}</div>
                <div className="text-xs text-muted-foreground" title={dateLabel(heldForRelease && rule.releaseAt ? rule.releaseAt : rule.windowEnd)}>{heldForRelease && rule.releaseAt ? `More released ${countdown(rule.releaseAt)}` : rule.releaseWindowUnknown || rule.usageUnavailable ? "Waiting for provider window" : `Resets ${countdown(rule.windowEnd)}`}</div>
                {rule.usageStale && <div className="text-xs text-muted-foreground" title={dateLabel(rule.usageObservedAt)}>Observed {rule.usageObservedAt ? relativeTime(rule.usageObservedAt) : "earlier"}</div>}
              </div>
              <div role="cell" className="flex gap-1 lg:col-span-1 lg:flex-col lg:items-end">
                <Button variant="ghost" size="sm" disabled={pending} aria-label={`Edit ${providerName(rule.provider)} ${windowName(rule.windowKind)} rule`} onClick={() => openEditor(rule)}>Edit</Button>
                <Button variant="ghost" size="sm" disabled={pending} aria-label={`Delete ${providerName(rule.provider)} ${windowName(rule.windowKind)} rule`} onClick={() => { setError(null); setDeleting(rule); }}>Delete</Button>
              </div>
            </div>;
          })}
          {rows.length === 0 && <div role="row"><div role="cell" className="px-5 py-8 text-sm text-muted-foreground">No subscription rules. Add a rule to limit a provider’s session or weekly usage.</div></div>}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Rules apply to provider account usage, including usage outside this company. Each provider resets independently. Runs wait while a matching rule holds them; a provider without a rule has no subscription budget limit.</p>
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !pending) setEditing(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingId ? "Edit budget rule" : "Add budget rule"}</DialogTitle><DialogDescription>Choose a provider and its quota window. There is one rule per provider and window.</DialogDescription></DialogHeader>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <div className="space-y-2"><Label htmlFor="budget-rule-provider">Provider</Label><select id="budget-rule-provider" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={provider} disabled={pending} onChange={(event) => setProvider(event.target.value as SubscriptionBudgetProvider)}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></div>
            <div className="space-y-2"><Label htmlFor="budget-rule-window">Window</Label><select id="budget-rule-window" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={windowKind} disabled={pending} onChange={(event) => setWindowKind(event.target.value as SubscriptionBudgetWindowKind)}><option value="provider_session">Session (5 hours)</option><option value="provider_week">Weekly (7 days)</option></select></div>
            <div className="space-y-2"><Label htmlFor="budget-rule-kind">Kind</Label><select id="budget-rule-kind" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={progressive ? "progressive" : "fixed"} disabled={pending} onChange={(event) => setProgressive(event.target.value === "progressive")}><option value="progressive">Progressive release</option><option value="fixed">Fixed limit</option></select></div>
            <div className="space-y-2"><Label htmlFor="budget-rule-limit">Limit (%)</Label><Input id="budget-rule-limit" type="number" min={1} max={100} step={1} value={amount} disabled={pending} onChange={(event) => setAmount(event.target.value)} /><p className="text-xs text-muted-foreground">{progressive && validAmount ? `Releases ${percent(Number(amount) / (windowKind === "provider_week" ? 7 : 5))} per ${windowKind === "provider_week" ? "day" : "hour"}.` : "Enter a whole percentage from 1 to 100."}</p></div>
            {(error || duplicate) && <p role="alert" className="text-sm text-destructive">{error ?? "A rule already exists for this provider and window. Edit that rule instead."}</p>}
            <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" disabled={pending || !validAmount || duplicate}>{pending ? "Saving…" : "Save rule"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && !pending) setDeleting(null); }}>
        <DialogContent><DialogHeader><DialogTitle>Delete budget rule?</DialogTitle><DialogDescription>Remove the {providerName(deleting?.provider)} {deleting ? windowName(deleting.windowKind).toLowerCase() : ""} rule. Runs will no longer be limited by this rule. Other rules still apply.</DialogDescription></DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" disabled={pending} onClick={() => void remove()}>{pending ? "Deleting…" : "Delete rule"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
