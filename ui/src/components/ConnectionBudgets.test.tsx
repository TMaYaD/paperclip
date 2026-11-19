// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetPolicySummary, CostByConnection } from "@paperclipai/shared";
import { ConnectionBudgets } from "./ConnectionBudgets";
import { ConnectionSpendTable } from "./ConnectionSpendTable";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MINIMAX = "8e4f0f9c-0a1b-4c55-9b8a-2b6f5e1d7c11";
const CLAUDE_API = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const spend = (overrides: Partial<CostByConnection>): CostByConnection => ({
  connectionId: null, connectionName: null, provider: "anthropic", connectionExists: true, costCents: 0, costCentsExact: "0",
  eventCount: 0, unpricedEventCount: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, agentCount: 0, ...overrides,
});
const connections = [
  spend({ costCents: 300, eventCount: 3, agentCount: 1 }),
  spend({ connectionId: MINIMAX, connectionName: "my api.minimax.io", costCents: 120, eventCount: 2, agentCount: 1 }),
  spend({ connectionId: CLAUDE_API, connectionName: "My Claude API" }),
];
const rule: BudgetPolicySummary = {
  policyId: "minimax-rule", companyId: "company", scopeType: "company", scopeId: "company", scopeName: "Company",
  connectionFilter: MINIMAX, connectionName: "my api.minimax.io", metric: "billed_cents", windowKind: "calendar_month_utc",
  amount: 1000, observedAmount: 900, observedAmountExact: "900.0000000", remainingAmount: 100, utilizationPercent: 90,
  warnPercent: 80, hardStopEnabled: true, notifyEnabled: true, unpricedEventCount: 0, pendingRunCount: 0, unpricedUsagePolicy: "block",
  isActive: true, status: "warning", paused: false, pauseReason: null,
  windowStart: new Date("2026-11-01T00:00:00Z"), windowEnd: new Date("2026-12-01T00:00:00Z"),
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === text)!;
const submit = () => act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
async function typeAmount(value: string) {
  const input = document.querySelector<HTMLInputElement>("#connection-budget-amount")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function render(policies: BudgetPolicySummary[] = [rule], onSave = vi.fn().mockResolvedValue(undefined), onDelete = vi.fn().mockResolvedValue(undefined)) {
  await act(async () => root.render(<ConnectionBudgets policies={policies} connections={connections} onSave={onSave} onDelete={onDelete} />));
  return { onSave, onDelete };
}

describe("connection budgets", () => {
  it("shows each connection rule with its own spend and status", async () => {
    await render([rule, { ...rule, policyId: "base", connectionFilter: null }]);
    const rows = [...container.querySelectorAll('[role="rowgroup"] [role="row"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("my api.minimax.io");
    expect(rows[0].textContent).toContain("$9.00");
    expect(rows[0].textContent).toContain("of $10.00");
    expect(rows[0].textContent).toContain("Near limit");
  });

  it("adds a budget for an unbudgeted connection, in cents", async () => {
    const { onSave } = await render();
    await act(async () => button("Add connection budget").click());
    const select = document.querySelector<HTMLSelectElement>("#connection-budget-connection")!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Existing authentication — not managed by Connections", "my api.minimax.io", "My Claude API",
    ]);
    expect(select.value).toBe("unmanaged");
    await typeAmount("25.5");
    await submit();
    expect(onSave).toHaveBeenCalledWith({ connectionFilter: "unmanaged", amount: 2550 }, undefined);
  });

  it("edits an existing rule by ID without changing its connection", async () => {
    const { onSave } = await render();
    await act(async () => button("Edit").click());
    expect(document.querySelector<HTMLSelectElement>("#connection-budget-connection")!.disabled).toBe(true);
    await submit();
    expect(onSave).toHaveBeenCalledWith({ connectionFilter: MINIMAX, amount: 1000 }, "minimax-rule");
  });

  it("removes only after confirmation", async () => {
    const { onDelete } = await render();
    await act(async () => button("Remove").click());
    expect(onDelete).not.toHaveBeenCalled();
    await act(async () => button("Remove budget").click());
    expect(onDelete).toHaveBeenCalledWith("minimax-rule");
  });
});

describe("connection spend table", () => {
  it("lists connections separately and labels host credentials", async () => {
    await act(async () => root.render(<ConnectionSpendTable rows={connections} />));
    const rows = [...container.querySelectorAll('[role="rowgroup"] [role="row"]')].map((row) => row.textContent);
    expect(rows[0]).toContain("Existing authentication — not managed by Connections");
    expect(rows[0]).toContain("$3.00");
    expect(rows[1]).toContain("my api.minimax.io");
    expect(rows[1]).toContain("$1.20");
    expect(rows[2]).toContain("My Claude API");
  });

  it("hides the host-credential row when it has no usage", async () => {
    await act(async () => root.render(<ConnectionSpendTable rows={[spend({}), connections[1]]} />));
    expect(container.textContent).not.toContain("Existing authentication");
  });
});
