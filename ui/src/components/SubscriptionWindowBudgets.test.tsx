// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { SubscriptionWindowBudgets } from "./SubscriptionWindowBudgets";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const base: BudgetPolicySummary = {
  policyId: "openai-week", companyId: "company", scopeType: "company", scopeId: "company", scopeName: "Company",
  provider: "openai", metric: "subscription_percent", windowKind: "provider_week", amount: 100, progressive: true,
  releasedAmount: 0.3, observedAmount: 4, remainingAmount: 0, utilizationPercent: 4,
  releaseAt: "2026-09-27T09:43:20Z", warnPercent: 80, hardStopEnabled: true, notifyEnabled: true,
  isActive: true, status: "ok", paused: false, pauseReason: null,
  windowStart: new Date("2026-09-27T03:00:08Z"), windowEnd: new Date("2026-10-04T03:00:08Z"),
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === text)!;
async function render(policies = [base], onSave = vi.fn().mockResolvedValue(undefined), onDelete = vi.fn().mockResolvedValue(undefined)) {
  await act(async () => root.render(<SubscriptionWindowBudgets policies={policies} onSave={onSave} onDelete={onDelete} />));
  return { onSave, onDelete };
}
describe("provider budget rule table", () => {
  it("keeps independent release values, statuses and progress markers in each rich row", async () => {
    await render([base, { ...base, policyId: "anthropic-week", provider: "anthropic", observedAmount: 17, releasedAmount: 96.3, remainingAmount: 79.3, releaseAt: null }]);
    const rows = [...container.querySelectorAll('[role="rowgroup"] [role="row"]')];
    const openai = rows.find((r) => r.textContent?.includes("OpenAI"))!;
    const anthropic = rows.find((r) => r.textContent?.includes("Anthropic"))!;
    expect(openai.textContent).toContain("Released 0.3% so far");
    expect(openai.textContent).toContain("Waiting for release");
    expect(anthropic.textContent).toContain("Released 96.3% so far");
    expect(anthropic.textContent).toContain("Available");
    expect(openai.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(anthropic.querySelector('[role="progressbar"]')).not.toBeNull();
  });
  it("creates a rule for an unused provider/window pair", async () => {
    const { onSave } = await render([]);
    await act(async () => button("Add rule").click());
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSave).toHaveBeenCalledWith({ provider: "openai", windowKind: "provider_week", amount: 100, progressive: true }, undefined);
  });
  it("edits the selected rule by ID and keeps failed saves open", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Rule changed; try again"));
    await render([base], onSave);
    await act(async () => button("Edit").click());
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai" }), "openai-week");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Rule changed; try again");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it("deletes only after the row-specific confirmation", async () => {
    const { onDelete } = await render();
    await act(async () => button("Delete").click());
    expect(onDelete).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("OpenAI weekly");
    await act(async () => button("Delete rule").click());
    expect(onDelete).toHaveBeenCalledWith("openai-week");
  });
});
