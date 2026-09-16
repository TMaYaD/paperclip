// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { BudgetPolicyCard } from "./BudgetPolicyCard";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function subscriptionSummary(overrides: Partial<BudgetPolicySummary> = {}): BudgetPolicySummary {
  const amount = overrides.amount ?? 80;
  const observedAmount = overrides.observedAmount ?? 40;
  return {
    policyId: "policy-session",
    companyId: "company-1",
    scopeType: "company",
    scopeId: "company-1",
    scopeName: "Acme",
    metric: "subscription_percent",
    windowKind: "provider_session",
    amount,
    progressive: false,
    releasedAmount: amount,
    releaseAt: null,
    observedAmount,
    remainingAmount: amount > 0 ? Math.max(0, amount - observedAmount) : 0,
    utilizationPercent: amount > 0 ? Number(((observedAmount / amount) * 100).toFixed(2)) : 0,
    usageUnavailable: false,
    warnPercent: 80,
    hardStopEnabled: true,
    notifyEnabled: true,
    isActive: amount > 0,
    status: "ok",
    paused: false,
    pauseReason: null,
    windowStart: new Date("2026-09-13T07:00:00.000Z"),
    windowEnd: new Date("2026-09-13T12:00:00.000Z"),
    ...overrides,
  };
}

describe("BudgetPolicyCard", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  function render(summary: BudgetPolicySummary, onSave?: (amount: number, options: { progressive: boolean }) => void) {
    root = createRoot(container);
    act(() => {
      root!.render(<BudgetPolicyCard summary={summary} onSave={onSave} />);
    });
    const query = (selector: string) => container.querySelector(selector) as HTMLElement | null;
    return {
      bar: query('[role="progressbar"]') as HTMLElement,
      marker: query('[data-testid="budget-limit-marker"]'),
      over: query('[data-testid="budget-over-limit"]'),
      held: query('[data-testid="budget-usage-held"]'),
      releasedTrack: query('[data-testid="budget-released-track"]'),
      releasedMarker: query('[data-testid="budget-released-marker"]'),
      overReleased: query('[data-testid="budget-over-released"]'),
      toggle: query('[data-testid="budget-progressive-toggle"]'),
      saveButton: Array.from(container.querySelectorAll("button")).find((button) =>
        /Set limit|Update limit|Set budget|Update budget/.test(button.textContent ?? ""),
      ) as HTMLButtonElement | undefined,
    };
  }

  function progressiveWeek(overrides: Partial<BudgetPolicySummary> = {}) {
    // 70% of the week releases 10% a day; 30% is out so far.
    return subscriptionSummary({
      windowKind: "provider_week",
      amount: 70,
      progressive: true,
      releasedAmount: 30,
      windowStart: new Date("2026-09-11T00:00:00.000Z"),
      windowEnd: new Date("2026-09-18T00:00:00.000Z"),
      ...overrides,
    });
  }

  it("draws subscription usage on the whole window with a marker at the limit", () => {
    // 40% of the window used, limit at 80%: the fill is the usage itself, not
    // the 50% utilization-of-limit, so "Remaining 40%" is the visible gap.
    const { bar, marker, over } = render(subscriptionSummary({ amount: 80, observedAmount: 40 }));
    expect(bar.style.width).toBe("40%");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.getAttribute("aria-label")).toBe("Window usage: 40% used, limit 80%");
    expect(marker?.style.left).toBe("calc(80% - 1px)");
    expect(marker?.getAttribute("title")).toBe("Limit 80%");
    expect(over).toBeNull();
    expect(container.textContent).toContain("Remaining");
    expect(container.textContent).toContain("40%");
    expect(container.textContent).toContain("50% of limit");
  });

  it("hatches the portion past the limit and says how far over the window is", () => {
    const { bar, marker, over } = render(
      subscriptionSummary({ amount: 50, observedAmount: 65, status: "hard_stop" }),
    );
    expect(bar.style.width).toBe("50%");
    expect(bar.className).toContain("bg-(--status-task-blocked)");
    expect(marker?.style.left).toBe("calc(50% - 1px)");
    expect(over?.style.left).toBe("50%");
    expect(over?.style.width).toBe("15%");
    expect(container.textContent).toContain("Over limit by 15%");
  });

  it("shows current window usage without a marker when no limit is configured yet", () => {
    const { bar, marker, over } = render(
      subscriptionSummary({ amount: 0, observedAmount: 72, isActive: false }),
    );
    expect(bar.style.width).toBe("72%");
    expect(bar.className).toContain("bg-muted-foreground/50");
    expect(bar.getAttribute("aria-label")).toBe("Budget utilization: 72% used");
    expect(marker).toBeNull();
    expect(over).toBeNull();
    expect(container.textContent).toContain("Unlimited");
  });

  it("keeps the last measurement, says how old it is, and reads held when a stale read sits under a limit", () => {
    // The gate never clears a run on a stale read, so under a limit the card
    // shows the hold while still drawing the last known usage and the marker.
    const observedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const { bar, marker, held } = render(
      subscriptionSummary({ amount: 80, observedAmount: 40, usageStale: true, usageObservedAt: observedAt }),
    );
    expect(bar.style.width).toBe("40%");
    expect(marker?.style.left).toBe("calc(80% - 1px)");
    expect(held).not.toBeNull();
    expect(container.textContent).toContain("40%");
    expect(container.textContent).toContain(
      "50% of limit · as of 3m ago, latest read failed; new runs wait for a fresh read",
    );
    expect(container.textContent).toContain("Runs held");
    expect(container.textContent).not.toContain("Unavailable");
    expect(container.textContent).not.toContain("Healthy");
  });

  it("trusts the server's held flag: a young stale read with headroom is not held", () => {
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    const { bar, marker, held } = render(
      subscriptionSummary({
        amount: 80,
        observedAmount: 40,
        usageStale: true,
        usageHeld: false,
        usageObservedAt: observedAt,
      }),
    );
    expect(bar.style.width).toBe("40%");
    expect(marker?.style.left).toBe("calc(80% - 1px)");
    expect(held).toBeNull();
    expect(container.textContent).toContain("Healthy");
    expect(container.textContent).toContain("latest read failed; new runs still clear on this read");
    expect(container.textContent).not.toContain("Runs held");
  });

  it("shows a stale read without a limit as plain usage, nothing held", () => {
    const observedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const { bar, held } = render(
      subscriptionSummary({ amount: 0, observedAmount: 40, isActive: false, usageStale: true, usageObservedAt: observedAt }),
    );
    expect(bar.style.width).toBe("40%");
    expect(held).toBeNull();
    expect(container.textContent).toContain("No cap configured · as of 3m ago, latest read failed");
    expect(container.textContent).not.toContain("new runs wait");
    expect(container.textContent).not.toContain("Runs held");
  });

  it("shows the limit over a hatched track and a held status when usage is unknown under a limit", () => {
    // The gate holds new runs whenever a limit cannot be checked, so the card
    // keeps the marker and reads as held, not merely unknown.
    const { bar, marker, over, held } = render(
      subscriptionSummary({ amount: 80, observedAmount: 0, usageUnavailable: true }),
    );
    expect(bar.style.width).toBe("0%");
    expect(bar.getAttribute("aria-label")).toBe("Window usage unknown, limit 80%; new runs are held");
    expect(marker?.style.left).toBe("calc(80% - 1px)");
    expect(held).not.toBeNull();
    expect(over).toBeNull();
    expect(container.textContent).toContain("Runs held");
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Provider did not report this window · new runs wait until it does");
    expect(container.textContent).toContain("Remaining");
    expect(container.textContent).not.toContain("Healthy");
  });

  it("renders an empty bar and an Unknown status when usage is unknown and no limit is set", () => {
    const { bar, marker, held } = render(
      subscriptionSummary({ amount: 0, observedAmount: 0, isActive: false, usageUnavailable: true }),
    );
    expect(bar.style.width).toBe("0%");
    expect(bar.getAttribute("aria-label")).toBe("Budget utilization unknown");
    expect(marker).toBeNull();
    expect(held).toBeNull();
    expect(container.textContent).toContain("Unknown");
    expect(container.textContent).not.toContain("Runs held");
    expect(container.textContent).toContain("Provider did not report this window");
    expect(container.textContent).not.toContain("new runs wait");
  });

  it("keeps money budgets as a plain utilization bar without a release toggle", () => {
    const onSave = vi.fn();
    const { bar, marker, over, releasedMarker, toggle, saveButton } = render(
      subscriptionSummary({
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 10_000,
        observedAmount: 2_500,
        remainingAmount: 7_500,
        utilizationPercent: 25,
        usageUnavailable: undefined,
      }),
      onSave,
    );
    expect(bar.style.width).toBe("25%");
    expect(bar.getAttribute("aria-label")).toBe("Budget utilization: 25% used");
    expect(marker).toBeNull();
    expect(over).toBeNull();
    expect(releasedMarker).toBeNull();
    expect(toggle).toBeNull();
    expect(saveButton?.textContent).toBe("Update budget");
    expect(container.textContent).toContain("$75.00");
    expect(container.textContent).not.toContain("Progressive release");
  });

  it("draws the released share of a progressive limit as a second indicator on the window", () => {
    // 20% used against 30% released of a 70% limit: the fill is the usage,
    // the tinted track and its marker show what is released so far, the
    // limit marker stays at 70%, and "Remaining" is the gap to the release.
    const { bar, marker, over, overReleased, releasedTrack, releasedMarker } = render(
      progressiveWeek({ observedAmount: 20, remainingAmount: 10, utilizationPercent: 28.57 }),
    );
    expect(bar.style.width).toBe("20%");
    expect(bar.getAttribute("aria-label")).toBe("Window usage: 20% used, limit 70%, 30% released so far");
    expect(releasedTrack?.style.width).toBe("30%");
    expect(releasedMarker?.style.left).toBe("calc(30% - 1px)");
    expect(releasedMarker?.getAttribute("title")).toBe("Released 30% so far");
    expect(marker?.style.left).toBe("calc(70% - 1px)");
    expect(over).toBeNull();
    expect(overReleased).toBeNull();
    expect(container.textContent).toContain("Healthy");
    expect(container.textContent).toContain("Progressive release · 10% per day · 30% released so far");
    expect(container.textContent).toContain("Remaining");
    expect(container.textContent).toContain("10%");
  });

  it("reads waiting for release and hatches usage ahead of the released share in the warning tone", () => {
    // 35% used with 30% released: runs wait for the next release, not the
    // reset, so this is the budget's normal rhythm rather than a hard stop.
    const releaseAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const { bar, marker, over, overReleased, releasedMarker } = render(
      progressiveWeek({ observedAmount: 35, remainingAmount: 0, utilizationPercent: 50, releaseAt }),
    );
    expect(bar.style.width).toBe("30%");
    expect(bar.className).toContain("bg-(--status-task-todo)");
    expect(overReleased?.style.left).toBe("30%");
    expect(overReleased?.style.width).toBe("5%");
    expect(over).toBeNull();
    expect(releasedMarker?.style.left).toBe("calc(30% - 1px)");
    expect(marker?.style.left).toBe("calc(70% - 1px)");
    expect(container.textContent).toContain("Waiting for release");
    expect(container.textContent).toContain("Ahead of release by 5% · more in 2h");
    expect(container.textContent).not.toContain("Hard stop");
    expect(container.textContent).not.toContain("Healthy");
  });

  it("treats a fully released progressive limit like a fixed one", () => {
    // Past the window (or without a reset time) the whole limit is out: the
    // two indicators coincide, so only the limit marker and the over-limit
    // hatch remain.
    const { bar, marker, over, overReleased, releasedTrack, releasedMarker } = render(
      progressiveWeek({ releasedAmount: 70, observedAmount: 80, remainingAmount: 0, utilizationPercent: 114.29, status: "hard_stop" }),
    );
    expect(bar.style.width).toBe("70%");
    expect(releasedTrack).toBeNull();
    expect(releasedMarker).toBeNull();
    expect(overReleased).toBeNull();
    expect(marker?.style.left).toBe("calc(70% - 1px)");
    expect(over?.style.width).toBe("10%");
    expect(container.textContent).toContain("Over limit by 10%");
    expect(container.textContent).toContain("Hard stop");
    expect(container.textContent).toContain("Progressive release · 10% per day · fully released");
  });

  it("says when the full limit is in force only because the reset time is unknown", () => {
    // Without a window position nothing can be pro-rated; the card must not
    // dress that up as the schedule having run its course.
    const { releasedMarker, releasedTrack } = render(
      progressiveWeek({ releasedAmount: 70, releaseWindowUnknown: true, observedAmount: 40, remainingAmount: 30, utilizationPercent: 57.14 }),
    );
    expect(releasedMarker).toBeNull();
    expect(releasedTrack).toBeNull();
    expect(container.textContent).toContain("Progressive release · 10% per day · reset time unknown, full limit in force");
    expect(container.textContent).not.toContain("fully released");
  });

  it("saves the drafted release mode together with the limit", () => {
    const onSave = vi.fn();
    const { toggle, saveButton } = render(subscriptionSummary({ amount: 80, observedAmount: 40 }), onSave);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Release the limit evenly over the window instead of all at once");
    // Same amount, same mode: nothing to save yet.
    expect(saveButton?.disabled).toBe(true);

    act(() => toggle!.click());
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Releases the limit evenly over the window, about 16% per hour");
    expect(saveButton?.disabled).toBe(false);

    act(() => saveButton!.click());
    expect(onSave).toHaveBeenCalledWith(80, { progressive: true });
  });

  it("does not offer to save a release mode with no limit to release", () => {
    const onSave = vi.fn();
    const { toggle, saveButton } = render(subscriptionSummary({ amount: 0, observedAmount: 40, isActive: false }), onSave);
    act(() => toggle!.click());
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(saveButton?.disabled).toBe(true);
  });
});
