import { useState } from "react";
import type { BudgetPolicySummary, CostByConnection } from "@paperclipai/shared";
import { CheckCircle2, PauseCircle, Plus, TriangleAlert } from "lucide-react";
import { BudgetUsageBar } from "./BudgetPolicyCard";
import { connectionLabel } from "./ConnectionSpendTable";
import { cn, formatCents } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

export type ConnectionBudgetInput = { connectionFilter: string; amount: number };

const scopeLabel = (rule: BudgetPolicySummary) => rule.scopeType === "company" ? "Organization" : rule.scopeName;
const ruleLabel = (rule: BudgetPolicySummary) => connectionLabel({ connectionKey: rule.connectionFilter, connectionName: rule.connectionName });

/**
 * Monthly money budgets that count only the spend on one AI connection (or a
 * harness's local credentials). A hard stop holds new runs on that connection
 * until the budget is raised or the month resets; agents on other connections
 * keep running, and runs already in progress finish.
 */
export function ConnectionBudgets({ policies, connections, onSave, onDelete }: {
  policies: BudgetPolicySummary[];
  /** Every AI connection in the company and each harness's local credentials, for the picker. */
  connections: CostByConnection[];
  onSave: (input: ConnectionBudgetInput, policyId?: string) => Promise<unknown>;
  onDelete: (policyId: string) => Promise<unknown>;
}) {
  const rows = policies.filter((policy) => policy.metric === "billed_cents" && Boolean(policy.connectionFilter))
    .toSorted((a, b) => ruleLabel(a).localeCompare(ruleLabel(b)) || a.scopeType.localeCompare(b.scopeType));
  const companyRuleFilters = new Set(rows.filter((row) => row.scopeType === "company").map((row) => row.connectionFilter));
  const options = connections.filter((connection) => connection.connectionExists)
    .map((connection) => ({ value: connection.connectionKey, label: connectionLabel(connection) }));
  const [editing, setEditing] = useState<BudgetPolicySummary | "new" | null>(null);
  const [deleting, setDeleting] = useState<BudgetPolicySummary | null>(null);
  const [connectionFilter, setConnectionFilter] = useState("");
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editingId = editing && editing !== "new" ? editing.policyId : undefined;
  const duplicate = editing === "new" && companyRuleFilters.has(connectionFilter);
  const dollars = Number(amount);
  const validAmount = amount.trim() !== "" && Number.isFinite(dollars) && dollars > 0 && Math.round(dollars * 100) <= 2_147_483_647;

  function openEditor(rule: BudgetPolicySummary | "new") {
    const firstFree = options.find((option) => !companyRuleFilters.has(option.value));
    setConnectionFilter(rule === "new" ? firstFree?.value ?? options[0]?.value ?? "" : rule.connectionFilter ?? "");
    setAmount(rule === "new" ? "" : String(rule.amount / 100));
    setError(null);
    setEditing(rule);
  }

  async function save() {
    if (!validAmount || duplicate || !connectionFilter || pending) return;
    setPending(true);
    setError(null);
    try {
      await onSave({ connectionFilter, amount: Math.round(dollars * 100) }, editingId);
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the budget. Try again.");
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
      setError(cause instanceof Error ? cause.message : "Could not remove the budget. Try again.");
    } finally { setPending(false); }
  }

  return (
    <section className="space-y-3" aria-label="Connection budgets">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Connection budgets</h2>
          <p className="text-sm text-muted-foreground">Monthly spend limits for one AI connection, across every agent that uses it. When a budget is reached, new runs on that connection wait; agents on other connections keep running.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => openEditor("new")} disabled={pending || options.length === 0}><Plus />Add connection budget</Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-border" role="table" aria-label="Connection budget rules">
        <div role="row" className="hidden grid-cols-12 gap-6 border-b border-border bg-muted/30 px-5 py-3 text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground lg:grid">
          <div role="columnheader" className="col-span-3">Connection / scope</div>
          <div role="columnheader" className="col-span-5">Spend this month</div>
          <div role="columnheader" className="col-span-3">Status</div>
          <div role="columnheader" className="col-span-1 text-right">Actions</div>
        </div>
        <div role="rowgroup" className="divide-y divide-border">
          {rows.map((rule) => {
            const active = rule.isActive && rule.amount > 0;
            const observed = rule.observedAmountExact ? Number(rule.observedAmountExact) : rule.observedAmount;
            const status = !active ? "Disabled" : rule.status === "hard_stop" ? "Budget reached · runs on this connection wait" : rule.status === "warning" ? "Near limit" : "Within budget";
            const StatusIcon = rule.status === "hard_stop" ? PauseCircle : rule.status === "warning" ? TriangleAlert : CheckCircle2;
            return <div role="row" key={rule.policyId} className="grid grid-cols-1 items-center gap-5 bg-card px-5 py-5 lg:grid-cols-12 lg:gap-6">
              <div role="cell" className="space-y-1 lg:col-span-3">
                <div className="font-semibold">{ruleLabel(rule)}</div>
                <div className="text-sm text-muted-foreground">{scopeLabel(rule)}</div>
              </div>
              <div role="cell" className="space-y-3 lg:col-span-5">
                <div className="flex flex-wrap items-baseline justify-between gap-4">
                  <div className="text-2xl font-semibold tabular-nums tracking-tight">{formatCents(observed)}</div>
                  <div className="text-sm text-muted-foreground">of {active ? formatCents(rule.amount) : "no limit"}</div>
                </div>
                <BudgetUsageBar usedPercent={rule.utilizationPercent} limitPercent={null} releasedPercent={null} status={rule.status} unavailable={false} neutral={!active} held={false} className="bg-muted/70" />
                {rule.pendingRunCount > 0 || rule.unpricedEventCount > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    {rule.pendingRunCount > 0 ? `${rule.pendingRunCount} run(s) awaiting accounting` : ""}
                    {rule.pendingRunCount > 0 && rule.unpricedEventCount > 0 ? " · " : ""}
                    {rule.unpricedEventCount > 0 ? `${rule.unpricedEventCount} unpriced event(s)` : ""}
                  </div>
                ) : null}
              </div>
              <div role="cell" className="lg:col-span-3">
                <div className={cn("flex items-center gap-2 text-sm font-medium", rule.status === "hard_stop" ? "text-destructive" : rule.status === "warning" ? "text-(--status-task-todo)" : active ? "text-(--status-task-done)" : "text-muted-foreground")}><StatusIcon className="size-4 shrink-0" />{status}</div>
              </div>
              <div role="cell" className="flex gap-1 lg:col-span-1 lg:flex-col lg:items-end">
                <Button variant="ghost" size="sm" disabled={pending} aria-label={`Edit ${ruleLabel(rule)} budget`} onClick={() => openEditor(rule)}>Edit</Button>
                <Button variant="ghost" size="sm" disabled={pending} aria-label={`Remove ${ruleLabel(rule)} budget`} onClick={() => { setError(null); setDeleting(rule); }}>Remove</Button>
              </div>
            </div>;
          })}
          {rows.length === 0 && <div role="row"><div role="cell" className="px-5 py-8 text-sm text-muted-foreground">No connection budgets. Add one to cap the monthly spend of a single connection that several agents share.</div></div>}
        </div>
      </div>
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !pending) setEditing(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingId ? "Edit connection budget" : "Add connection budget"}</DialogTitle><DialogDescription>Counts this month’s spend on the selected connection across all agents in the organization.</DialogDescription></DialogHeader>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <div className="space-y-2">
              <Label htmlFor="connection-budget-connection">Connection</Label>
              <select id="connection-budget-connection" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={connectionFilter} disabled={pending || Boolean(editingId)} onChange={(event) => setConnectionFilter(event.target.value)}>
                {editing && editing !== "new" && !options.some((option) => option.value === connectionFilter) ? <option value={connectionFilter}>{ruleLabel(editing)}</option> : null}
                {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-budget-amount">Monthly budget (USD)</Label>
              <Input id="connection-budget-amount" type="number" min={0.01} step={0.01} value={amount} disabled={pending} onChange={(event) => setAmount(event.target.value)} />
              <p className="text-xs text-muted-foreground">Enter a positive amount. When it is reached, new runs on this connection wait until you raise the budget or the month resets. Runs in progress finish.</p>
            </div>
            {(error || duplicate) && <p role="alert" className="text-sm text-destructive">{error ?? "This connection already has an organization budget. Edit that budget instead."}</p>}
            <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" disabled={pending || !validAmount || duplicate || !connectionFilter}>{pending ? "Saving…" : "Save budget"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && !pending) setDeleting(null); }}>
        <DialogContent><DialogHeader><DialogTitle>Remove connection budget?</DialogTitle><DialogDescription>Spend on {deleting ? ruleLabel(deleting) : "this connection"} will no longer be limited by this budget. Runs waiting on it start at their next check.</DialogDescription></DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" disabled={pending} onClick={() => void remove()}>{pending ? "Removing…" : "Remove budget"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
