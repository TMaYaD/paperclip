// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionBlocker, IssueRecoveryAction } from "@paperclipai/shared";
import { CancelledRunReconciliation } from "./CancelledRunReconciliation";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const api = vi.hoisted(() => ({ recoveryActions: vi.fn(), resolveRecoveryAction: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi: api }));

const runId = "11111111-1111-4111-8111-111111111111";
const blocker: ExecutionBlocker = {
  recoveryActionId: "a", runId, agentId: "agent", cause: "uncertain_external_action",
  nextAction: "Inspect the run.", runStatus: "cancelled", canContinue: false, canRetry: false,
};
function action(id: string, held = true): IssueRecoveryAction {
  return { id, companyId: "company", sourceIssueId: "issue", recoveryIssueId: null,
    kind: "active_run_watchdog", status: "resolved", ownerType: "board", ownerAgentId: null,
    ownerUserId: null, previousOwnerAgentId: null, returnOwnerAgentId: "agent",
    cause: "uncertain_external_action", fingerprint: id, evidence: { runId,
      ...(held ? { automaticRecovery: { replay: "blocked" } } : {}) }, nextAction: "Inspect the run.",
    wakePolicy: null, monitorPolicy: null, attemptCount: 1, maxAttempts: null,
    timeoutAt: null, lastAttemptAt: null, outcome: "blocked", resolutionNote: null,
    resolvedAt: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
}

describe("cancelled run reconciliation", () => {
  let root: Root;
  let container: HTMLDivElement;
  const refreshed = vi.fn();
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {} unobserve() {} disconnect() {}
    };
    api.recoveryActions.mockReset(); api.resolveRecoveryAction.mockReset(); refreshed.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  async function render(value: ExecutionBlocker | null = blocker, canResolve = true) {
    await act(async () => root.render(<CancelledRunReconciliation blocker={value} issueId="issue"
      canResolve={canResolve} onResolved={refreshed} />));
  }
  it("offers reconciliation only for an authorized cancelled source without Retry or Continue", async () => {
    await render(); expect(container.textContent).toContain("Reconcile");
    await render({ ...blocker, runStatus: "failed" }); expect(container.textContent).not.toContain("Reconcile");
    await render({ ...blocker, canRetry: true }); expect(container.textContent).not.toContain("Reconcile");
    await render({ ...blocker, runId: null }); expect(container.textContent).not.toContain("Reconcile");
    await render(blocker, false); expect(container.textContent).not.toContain("Reconcile");
    await render({ ...blocker, workspaceRepairRequired: true }); expect(container.textContent).not.toContain("Reconcile");
  });
  it("requires stop confirmation, an outcome, and at least 20 trimmed evidence characters", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const submit = () => act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("provider has stopped");
    await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Choose what happened");
    await act(async () => { const select = container.querySelector("select")!; select.value = "completed";
      select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { const textarea = container.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "  short  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("20 to 12,000");
    expect(api.resolveRecoveryAction).not.toHaveBeenCalled();
  });
  it("submits exact evidence for each same-run hold and reports partial failure inline", async () => {
    api.recoveryActions.mockResolvedValueOnce({ active: null, actions: [action("a"), action("b")] })
      .mockResolvedValueOnce({ active: null, actions: [action("a", false), action("b")] })
      .mockResolvedValueOnce({ active: null, actions: [action("a", false), action("b")] })
      .mockResolvedValueOnce({ active: null, actions: [action("a", false), action("b", false)] });
    api.resolveRecoveryAction.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Source owner changed"))
      .mockResolvedValueOnce({});
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.textContent).toContain("Provider stopped");
    const stopped = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
    const outcome = container.querySelector<HTMLSelectElement>("select")!;
    const evidence = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => stopped.click());
    await act(async () => { outcome.value = "mixed"; outcome.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(evidence,
        "  Receipts show one completed action and one unperformed action.  ");
      evidence.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(api.resolveRecoveryAction).toHaveBeenCalledTimes(2);
    expect(api.resolveRecoveryAction).toHaveBeenNthCalledWith(1, "issue", {
      actionId: "a", outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "mixed",
        outcomeEvidence: "Receipts show one completed action and one unperformed action." },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Source owner changed");
    expect(evidence.value).toContain("Receipts show");
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(api.resolveRecoveryAction).toHaveBeenCalledTimes(3);
    expect(api.resolveRecoveryAction.mock.calls[2]?.[1].actionId).toBe("b");
    expect(container.textContent).toContain("Reconciliation complete");
  });
});
