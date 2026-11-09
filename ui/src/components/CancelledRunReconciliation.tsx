import { useState, type FormEvent } from "react";
import { requiresExecutionReconciliation, type ExecutionBlocker, type ExecutionReconciliation, type IssueRecoveryAction } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { NativeSelect } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { cn } from "../lib/utils";

function matchingHold(action: IssueRecoveryAction, issueId: string, runId: string): boolean {
  const automatic = action.evidence.automaticRecovery as { replay?: string } | undefined;
  return action.sourceIssueId === issueId &&
    ["resolved", "cancelled"].includes(action.status) &&
    requiresExecutionReconciliation(action.cause) &&
    (action.evidence.runId === runId || action.evidence.sourceRunId === runId) &&
    automatic?.replay === "blocked";
}

export function CancelledRunReconciliation({ blocker, issueId, canResolve, onResolved, className }: {
  blocker: ExecutionBlocker | null | undefined;
  issueId: string;
  canResolve: boolean;
  onResolved: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [outcome, setOutcome] = useState<ExecutionReconciliation["actionOutcome"] | "">("");
  const [evidence, setEvidence] = useState("");
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!canResolve || blocker?.runStatus !== "cancelled" || !blocker.runId || !blocker.recoveryActionId ||
      blocker.canContinue || blocker.canRetry || blocker.workspaceRepairRequired ||
      !requiresExecutionReconciliation(blocker.cause)) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const note = evidence.trim();
    if (!stopped) { setError("Confirm that the provider has stopped."); return; }
    if (!outcome) { setError("Choose what happened to the run's actions."); return; }
    if (note.length < 20 || note.length > 12_000) { setError("Outcome evidence must contain 20 to 12,000 characters."); return; }
    setError(null);
    setPending(true);
    try {
      let lastResolvedId: string | null = null;
      let cleared = 0;
      while (true) {
        const current = await issuesApi.recoveryActions(issueId);
        const remaining = current.actions.filter((action) => matchingHold(action, issueId, blocker.runId!));
        if (lastResolvedId && remaining.some((action) => action.id === lastResolvedId)) {
          throw new Error("The recovery hold remains active. Refresh the task before retrying.");
        }
        if (remaining.length === 0) {
          if (cleared || completed) { setDone(true); setOpen(false); onResolved(); }
          else setError("The recovery hold changed. Refresh the task before reconciling.");
          break;
        }
        const next = remaining.find((action) => action.id === blocker.recoveryActionId) ?? remaining[0]!;
        await issuesApi.resolveRecoveryAction(issueId, {
          actionId: next.id, outcome: "restored", sourceIssueStatus: "todo",
          executionReconciliation: { runId: blocker.runId!, providerStopped: true, actionOutcome: outcome,
            outcomeEvidence: note },
        });
        lastResolvedId = next.id;
        cleared += 1;
        setCompleted((value) => value + 1);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reconciliation failed. Refresh and try again.");
      onResolved();
    } finally {
      setPending(false);
    }
  };

  return <div className={cn("rounded-md border border-border bg-card p-3 text-sm", className)}>
    <div className="flex items-center justify-between gap-3">
      <span>Work stopped after cancellation. Inspect the run before recording its outcome.</span>
      <Button type="button" variant="outline" size="sm" onClick={() => { setOpen((value) => !value); setDone(false); }}>
        Reconcile
      </Button>
    </div>
    {done && <p role="status" className="mt-2 text-muted-foreground">Reconciliation complete. The task is ready for normal admission checks.</p>}
    {open && <form onSubmit={submit} className="mt-3 space-y-3">
      <label className="flex items-center gap-2"><Checkbox checked={stopped} onCheckedChange={(value) => setStopped(value === true)} />Provider stopped</label>
      <label className="block space-y-1">Run actions
        <NativeSelect value={outcome}
          onChange={(event) => setOutcome(event.target.value as ExecutionReconciliation["actionOutcome"] | "")}>
          <option value="">Choose an outcome</option>
          <option value="completed">Completed</option>
          <option value="not_performed">Not performed</option>
          <option value="mixed">Mixed</option>
        </NativeSelect>
      </label>
      <label className="block space-y-1">Outcome evidence
        <Textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} maxLength={12_000}
          placeholder="Record what the provider did and the evidence you checked." />
      </label>
      {completed > 0 && <p role="status" className="text-muted-foreground">{completed} hold {completed === 1 ? "row" : "rows"} reconciled.</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="flex justify-end"><Button type="submit" disabled={pending}>{pending ? "Reconciling…" : "Reconcile holds"}</Button></div>
    </form>}
  </div>;
}
