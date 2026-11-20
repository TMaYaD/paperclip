// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetPolicySummary, CostByConnection } from "@paperclipai/shared";
import { SubscriptionWindowBudgets } from "./SubscriptionWindowBudgets";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const base: BudgetPolicySummary = {
  policyId: "openai-week", companyId: "company", scopeType: "company", scopeId: "company", scopeName: "Company",
  provider: "openai", connectionFilter: "local:openai", connectionName: "Codex local credentials", metric: "subscription_percent", windowKind: "provider_week", amount: 100, progressive: true,
  releasedAmount: 0.3, observedAmount: 4, remainingAmount: 0, utilizationPercent: 4,
  releaseAt: "2026-09-27T09:43:20Z", warnPercent: 80, hardStopEnabled: true, notifyEnabled: true,
  unpricedEventCount: 0, pendingRunCount: 0, unpricedUsagePolicy: "block",
  isActive: true, status: "ok", paused: false, pauseReason: null,
  windowStart: new Date("2026-09-27T03:00:08Z"), windowEnd: new Date("2026-10-04T03:00:08Z"),
};
const SUBSCRIPTION = "8e4f0f9c-0a1b-4c55-9b8a-2b6f5e1d7c11";
const connection = (overrides: Partial<CostByConnection>): CostByConnection => ({
  connectionKey: "local:openai", connectionId: null, connectionName: "Codex local credentials", provider: "openai", method: null,
  usageSupported: true, connectionExists: true, costCents: 0, costCentsExact: "0", eventCount: 0, unpricedEventCount: 0,
  inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, agentCount: 0, ...overrides,
});
const connections = [
  connection({}),
  connection({ connectionKey: "local:anthropic", connectionName: "Claude Code local credentials", provider: "anthropic" }),
  connection({ connectionKey: SUBSCRIPTION, connectionId: SUBSCRIPTION, connectionName: "Second Claude subscription", provider: "anthropic", method: "subscription" }),
  connection({ connectionKey: "a1b2c3d4-0a1b-4c55-9b8a-2b6f5e1d7c11", connectionId: "a1b2c3d4-0a1b-4c55-9b8a-2b6f5e1d7c11", connectionName: "My Claude API", method: "api_key", usageSupported: false }),
];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === text)!;
async function render(policies = [base], onSave = vi.fn().mockResolvedValue(undefined), onDelete = vi.fn().mockResolvedValue(undefined),
  onActiveChange = vi.fn().mockResolvedValue(undefined)) {
  await act(async () => root.render(<SubscriptionWindowBudgets policies={policies} connections={connections} onSave={onSave} onDelete={onDelete} onActiveChange={onActiveChange} />));
  return { onSave, onDelete, onActiveChange };
}
describe("provider budget rule table", () => {
  it("keeps independent release values, statuses and progress markers in each rich row", async () => {
    await render([base, { ...base, policyId: "anthropic-week", provider: "anthropic", connectionFilter: SUBSCRIPTION, connectionName: "Second Claude subscription", observedAmount: 17, releasedAmount: 96.3, remainingAmount: 79.3, releaseAt: null }]);
    const rows = [...container.querySelectorAll('[role="rowgroup"] [role="row"]')];
    const openai = rows.find((r) => r.textContent?.includes("Codex local credentials"))!;
    const anthropic = rows.find((r) => r.textContent?.includes("Second Claude subscription"))!;
    expect(openai.textContent).toContain("Released 0.3% so far");
    expect(openai.textContent).toContain("Waiting for release");
    expect(anthropic.textContent).toContain("Released 96.3% so far");
    expect(anthropic.textContent).toContain("Within pace");
    expect(openai.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(anthropic.querySelector('[role="progressbar"]')).not.toBeNull();
  });
  it("creates a rule for an unused provider/window pair", async () => {
    const { onSave } = await render([]);
    await act(async () => button("Add rule").click());
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSave).toHaveBeenCalledWith({ connectionFilter: "local:openai", windowKind: "provider_week", amount: 100, progressive: true, pacePercent: 20 }, undefined);
  });
  it("adds a cap alongside an existing pace on the same provider window", async () => {
    const { onSave } = await render();
    await act(async () => button("Add rule").click());
    expect(document.querySelector("label[for=budget-rule-limit]")?.textContent).toBe("Usage cap (%)");
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSave).toHaveBeenCalledWith({ connectionFilter: "local:openai", windowKind: "provider_week", amount: 100, progressive: false, pacePercent: null }, undefined);
  });
  it("preserves the precise migrated pace when its rounded input is unchanged", async () => {
    const { onSave } = await render([{ ...base, pacePercent: 100 / 7 }]);
    await act(async () => button("Edit").click());
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ pacePercent: 100 / 7 }), base.policyId);
  });
  it("edits the selected rule by ID and keeps failed saves open", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Rule changed; try again"));
    await render([base], onSave);
    await act(async () => button("Edit").click());
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ connectionFilter: "local:openai" }), "openai-week");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Rule changed; try again");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it("offers only connections whose usage Paperclip can read, each with its own windows", async () => {
    const { onSave } = await render([]);
    await act(async () => button("Add rule").click());
    const select = document.querySelector<HTMLSelectElement>("#budget-rule-connection")!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Codex local credentials", "Claude Code local credentials", "Second Claude subscription",
    ]);
    expect([...document.querySelector<HTMLSelectElement>("#budget-rule-window")!.options].map((option) => option.value))
      .toEqual(["provider_session", "provider_day", "provider_week", "provider_month"]);
    await act(async () => { select.value = SUBSCRIPTION; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ connectionFilter: SUBSCRIPTION }), undefined);
  });
  it("deletes only after the row-specific confirmation", async () => {
    const { onDelete } = await render();
    await act(async () => button("Delete").click());
    expect(onDelete).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Codex local credentials weekly");
    await act(async () => button("Delete rule").click());
    expect(onDelete).toHaveBeenCalledWith("openai-week");
  });
  it("turns a rule off and on from its row, keeping the saved cap", async () => {
    const cap = { ...base, policyId: "cap", progressive: false, pacePercent: null, amount: 0, configuredAmount: 70, isActive: false, status: "ok" as const };
    const { onActiveChange, onSave } = await render([cap]);
    expect(container.textContent).toContain("70%");
    expect(container.textContent).toContain("Off · not enforced");
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    expect(onActiveChange).toHaveBeenCalledWith(expect.objectContaining({ policyId: "cap" }), true);
    await act(async () => button("Edit").click());
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ amount: 70, progressive: false }), "cap");
  });
  it("shows a failed toggle inline", async () => {
    await render([base], undefined, undefined, vi.fn().mockRejectedValue(new Error("Rule changed; try again")));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Rule changed; try again");
  });
});
