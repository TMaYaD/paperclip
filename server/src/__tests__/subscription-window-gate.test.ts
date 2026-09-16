import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import {
  boundSubscriptionWindowWait,
  decideSubscriptionWindowWait,
  evaluateSubscriptionRelease,
  isSubscriptionUsageHeld,
  judgeStaleRead,
  observeSubscriptionWindow,
  releaseSubscriptionLimit,
  type SubscriptionWindowPolicy,
} from "../services/subscription-window-gate.ts";
import { createQuotaSnapshotReader, isRateLimitedQuotaResult } from "../services/quota-windows.ts";

const NOW = new Date("2026-09-13T12:00:00.000Z");

function window(overrides: Partial<QuotaWindow> & Pick<QuotaWindow, "key">): QuotaWindow {
  return {
    label: overrides.key ?? "window",
    usedPercent: null,
    resetsAt: null,
    valueLabel: null,
    detail: null,
    ...overrides,
  };
}

function policy(overrides: Partial<SubscriptionWindowPolicy> = {}): SubscriptionWindowPolicy {
  return {
    id: "policy-session",
    scopeType: "company",
    scopeId: "company-1",
    windowKind: "provider_session",
    amount: 80,
    progressive: false,
    ...overrides,
  };
}

function ok(windows: QuotaWindow[]): ProviderQuotaResult {
  return { provider: "anthropic", ok: true, windows };
}

describe("decideSubscriptionWindowWait", () => {
  it("returns null while usage is below every policy limit", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [policy(), policy({ id: "policy-week", windowKind: "provider_week", amount: 90 })],
      result: ok([
        window({ key: "five_hour", usedPercent: 79, resetsAt: "2026-09-13T14:00:00.000Z" }),
        window({ key: "seven_day", usedPercent: 50, resetsAt: "2026-09-18T00:00:00.000Z" }),
      ]),
      provider: "anthropic",
      now: NOW,
    });
    expect(wait).toBeNull();
  });

  it("defers to just after the window reset when usage reaches the limit", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [policy()],
      result: ok([window({ key: "five_hour", usedPercent: 80, resetsAt: "2026-09-13T14:00:00.000Z" })]),
      provider: "anthropic",
      now: NOW,
    });
    expect(wait).toMatchObject({
      policyId: "policy-session",
      windowKind: "provider_session",
      quotaKey: "five_hour",
      provider: "anthropic",
      usedPercent: 80,
      usageUnknown: false,
      limitPercent: 80,
      progressive: false,
      releasedPercent: 80,
      releaseAt: null,
      resetsAt: "2026-09-13T14:00:00.000Z",
    });
    expect(wait!.resumeAt.toISOString()).toBe("2026-09-13T14:00:30.000Z");
    expect(wait!.reason).toContain("session subscription window is at 80%");
  });

  it("falls back to the default wait when the provider reports no usable reset time", () => {
    const stale = decideSubscriptionWindowWait({
      policies: [policy()],
      result: ok([window({ key: "five_hour", usedPercent: 95, resetsAt: "2026-09-13T11:00:00.000Z" })]),
      provider: "anthropic",
      now: NOW,
      defaultWaitMs: 60_000,
    });
    expect(stale?.resetsAt).toBeNull();
    expect(stale?.resumeAt.toISOString()).toBe("2026-09-13T12:01:00.000Z");

    const missing = decideSubscriptionWindowWait({
      policies: [policy()],
      result: ok([window({ key: "five_hour", usedPercent: 95, resetsAt: null })]),
      provider: "anthropic",
      now: NOW,
      defaultWaitMs: 60_000,
    });
    expect(missing?.resumeAt.toISOString()).toBe("2026-09-13T12:01:00.000Z");
  });

  it("waits for the latest reset when both the session and the week block", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [policy(), policy({ id: "policy-week", windowKind: "provider_week", amount: 90 })],
      result: ok([
        window({ key: "five_hour", usedPercent: 100, resetsAt: "2026-09-13T14:00:00.000Z" }),
        window({ key: "seven_day", usedPercent: 91, resetsAt: "2026-09-18T00:00:00.000Z" }),
      ]),
      provider: "anthropic",
      now: NOW,
    });
    expect(wait?.policyId).toBe("policy-week");
    expect(wait?.resumeAt.toISOString()).toBe("2026-09-18T00:00:30.000Z");
  });

  it("holds new runs for a short re-check when a limited window cannot be read", () => {
    const missingWindow = decideSubscriptionWindowWait({
      policies: [policy()],
      result: ok([window({ key: "seven_day", usedPercent: 100 })]),
      provider: "anthropic",
      now: NOW,
      unknownWaitMs: 5 * 60_000,
    });
    expect(missingWindow).toMatchObject({
      policyId: "policy-session",
      quotaKey: "five_hour",
      usedPercent: null,
      usageUnknown: true,
      limitPercent: 80,
      resetsAt: null,
    });
    expect(missingWindow?.resumeAt.toISOString()).toBe("2026-09-13T12:05:00.000Z");
    expect(missingWindow?.reason).toContain("did not report this window");

    const noUtilization = decideSubscriptionWindowWait({
      policies: [policy()],
      result: ok([window({ key: "five_hour", usedPercent: null })]),
      provider: "anthropic",
      now: NOW,
    });
    expect(noUtilization).toMatchObject({ usageUnknown: true, usedPercent: null });
    expect(noUtilization?.reason).toContain("without utilization");

    const failedRead = decideSubscriptionWindowWait({
      policies: [policy()],
      result: { provider: "anthropic", ok: false, error: "Claude CLI /usage: probe ended early", windows: [] },
      provider: "anthropic",
      now: NOW,
    });
    expect(failedRead).toMatchObject({ usageUnknown: true, usedPercent: null });
    expect(failedRead?.reason).toContain("Claude CLI /usage: probe ended early");

    const noRow = decideSubscriptionWindowWait({ policies: [policy()], result: null, provider: "anthropic", now: NOW });
    expect(noRow).toMatchObject({ usageUnknown: true });
  });

  it("lets a stale read defer to the reset, and clear a run only while young with headroom", () => {
    const staleAt = {
      provider: "anthropic",
      ok: true,
      stale: true,
      rateLimited: true,
      observedAt: "2026-09-13T11:52:00.000Z",
      error: "Anthropic OAuth usage: 429",
      windows: [window({ key: "five_hour", usedPercent: 85, resetsAt: "2026-09-13T14:00:00.000Z" })],
    } satisfies ProviderQuotaResult;
    const saturated = decideSubscriptionWindowWait({ policies: [policy()], result: staleAt, provider: "anthropic", now: NOW });
    expect(saturated).toMatchObject({ usedPercent: 85, usageUnknown: false, resetsAt: "2026-09-13T14:00:00.000Z" });
    expect(saturated?.resumeAt.toISOString()).toBe("2026-09-13T14:00:30.000Z");

    // Eight minutes old is older than the gate accepts, however much headroom.
    const tooOld = decideSubscriptionWindowWait({
      policies: [policy()],
      result: { ...staleAt, windows: [window({ key: "five_hour", usedPercent: 40 })] },
      provider: "anthropic",
      now: NOW,
      unknownWaitMs: 5 * 60_000,
      staleReadMaxAgeMs: 3 * 60_000,
    });
    expect(tooOld).toMatchObject({ usedPercent: null, usageUnknown: true });
    expect(tooOld?.resumeAt.toISOString()).toBe("2026-09-13T12:05:00.000Z");
    expect(tooOld?.reason).toContain("was throttled (Anthropic OAuth usage: 429)");
    expect(tooOld?.reason).toContain("last good read of 40% at 2026-09-13T11:52:00.000Z is 8 min old, older than the gate accepts");

    // By default even a one-minute-old read at 40% holds: stale reads never
    // clear a run unless the operator opts in.
    const young = { ...staleAt, observedAt: "2026-09-13T11:59:00.000Z" };
    const strict = decideSubscriptionWindowWait({
      policies: [policy()],
      result: { ...young, windows: [window({ key: "five_hour", usedPercent: 40 })] },
      provider: "anthropic",
      now: NOW,
    });
    expect(strict).toMatchObject({ usedPercent: null, usageUnknown: true });
    expect(strict?.reason).toContain("stale reads are not accepted unless PAPERCLIP_SUBSCRIPTION_WINDOW_STALE_READ_MAX_AGE_MS is set");

    // Opted in with a three-minute allowance, that read clears the run: a
    // throttled minute no longer holds every queued run.
    expect(
      decideSubscriptionWindowWait({
        policies: [policy()],
        result: { ...young, windows: [window({ key: "five_hour", usedPercent: 40 })] },
        provider: "anthropic",
        now: NOW,
        staleReadMaxAgeMs: 3 * 60_000,
      }),
    ).toBeNull();

    // The same age at 79.5% projects past 80% with one percent a minute of
    // drift, so it holds even when opted in.
    const tight = decideSubscriptionWindowWait({
      policies: [policy()],
      result: { ...young, windows: [window({ key: "five_hour", usedPercent: 79.5 })] },
      provider: "anthropic",
      now: NOW,
      staleReadMaxAgeMs: 3 * 60_000,
    });
    expect(tight).toMatchObject({ usedPercent: null, usageUnknown: true });
    expect(tight?.reason).toContain("is 1 min old, which with usage drift may already be at the limit");

    // A fresh read below the limit clears the run as before.
    expect(
      decideSubscriptionWindowWait({
        policies: [policy()],
        result: ok([window({ key: "five_hour", usedPercent: 40 })]),
        provider: "anthropic",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("stays open without a limit even when usage cannot be read", () => {
    expect(
      decideSubscriptionWindowWait({ policies: [policy({ amount: 0 })], result: null, provider: "anthropic", now: NOW }),
    ).toBeNull();
    expect(
      decideSubscriptionWindowWait({
        policies: [],
        result: { provider: "anthropic", ok: false, error: "down", windows: [] },
        provider: "anthropic",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("lets a known saturated window outrank an unknown one", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [policy(), policy({ id: "policy-week", windowKind: "provider_week", amount: 90 })],
      result: ok([window({ key: "seven_day", usedPercent: 95, resetsAt: "2026-09-18T00:00:00.000Z" })]),
      provider: "anthropic",
      now: NOW,
    });
    expect(wait?.policyId).toBe("policy-week");
    expect(wait?.usageUnknown).toBe(false);
    expect(wait?.resumeAt.toISOString()).toBe("2026-09-18T00:00:30.000Z");
  });

  it("ignores policies with a zero limit and matches windows by key, not label", () => {
    expect(
      decideSubscriptionWindowWait({
        policies: [policy({ amount: 0 })],
        result: ok([window({ key: "five_hour", usedPercent: 100 })]),
        provider: "anthropic",
        now: NOW,
      }),
    ).toBeNull();
    // A window without the session key is not the session window, however it
    // is labeled: the policy holds for a re-check rather than reading its 100%.
    const mislabeled = decideSubscriptionWindowWait({
      policies: [policy()],
      result: ok([window({ key: null, label: "Current session", usedPercent: 100 })]),
      provider: "anthropic",
      now: NOW,
    });
    expect(mislabeled).toMatchObject({ usageUnknown: true, usedPercent: null });
  });
});

describe("progressive release", () => {
  // NOW is 12:00; a session resetting at 14:00 started at 09:00, so 3 of its
  // 5 hours (60%) have elapsed.
  const SESSION_RESET = "2026-09-13T14:00:00.000Z";
  const progressiveSession = () => policy({ amount: 100, progressive: true });

  it("releases a limit linearly over the window and falls back to the full limit without a reset time", () => {
    expect(
      releaseSubscriptionLimit({ limitPercent: 100, windowKind: "provider_session", progressive: true, resetsAt: SESSION_RESET, now: NOW }),
    ).toMatchObject({ releasedPercent: 60, elapsedFraction: 0.6 });
    // 70% of a week releases 10% a day: 2.5 days into the week, 25% is out.
    expect(
      releaseSubscriptionLimit({ limitPercent: 70, windowKind: "provider_week", progressive: true, resetsAt: "2026-09-18T00:00:00.000Z", now: NOW }).releasedPercent,
    ).toBeCloseTo(25, 10);
    // A fixed limit is in force in full at any point of the window.
    expect(
      releaseSubscriptionLimit({ limitPercent: 100, windowKind: "provider_session", progressive: false, resetsAt: SESSION_RESET, now: NOW }),
    ).toMatchObject({ releasedPercent: 100, elapsedFraction: 0.6 });
    // No usable reset (missing or already past): the window position is
    // unknown, so the ceiling applies and only the smoothing is lost.
    for (const resetsAt of [null, "2026-09-13T11:00:00.000Z"]) {
      expect(
        releaseSubscriptionLimit({ limitPercent: 100, windowKind: "provider_session", progressive: true, resetsAt, now: NOW }),
      ).toEqual({ releasedPercent: 100, elapsedFraction: null, windowStart: null, windowEnd: null });
    }
    // A reset further out than the window is long clamps to "just started".
    expect(
      releaseSubscriptionLimit({ limitPercent: 100, windowKind: "provider_session", progressive: true, resetsAt: "2026-09-14T00:00:00.000Z", now: NOW }),
    ).toMatchObject({ releasedPercent: 0, elapsedFraction: 0 });
  });

  it("names the moment the release catches up with usage, and the reset once the full limit is used", () => {
    const held = evaluateSubscriptionRelease({
      usedPercent: 75, limitPercent: 100, windowKind: "provider_session", progressive: true, resetsAt: SESSION_RESET, now: NOW,
    });
    // 75% of a 5h window past its 09:00 start is 12:45.
    expect(held.held).toBe(true);
    expect(held.releaseAt?.toISOString()).toBe("2026-09-13T12:45:00.000Z");
    expect(
      evaluateSubscriptionRelease({ usedPercent: 59, limitPercent: 100, windowKind: "provider_session", progressive: true, resetsAt: SESSION_RESET, now: NOW }),
    ).toMatchObject({ held: false, releaseAt: null });
    expect(
      evaluateSubscriptionRelease({ usedPercent: 100, limitPercent: 100, windowKind: "provider_session", progressive: true, resetsAt: SESSION_RESET, now: NOW }),
    ).toMatchObject({ held: true, releaseAt: null });
    // Nothing used yet is never held, even at the very start of a window when
    // nothing has been released either.
    expect(
      evaluateSubscriptionRelease({ usedPercent: 0, limitPercent: 100, windowKind: "provider_session", progressive: true, resetsAt: "2026-09-13T17:00:00.000Z", now: NOW }),
    ).toMatchObject({ held: false, releaseAt: null });
  });

  it("lets a run through while usage is under the released share", () => {
    expect(
      decideSubscriptionWindowWait({
        policies: [progressiveSession()],
        result: ok([window({ key: "five_hour", usedPercent: 59, resetsAt: SESSION_RESET })]),
        provider: "anthropic",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("defers a run ahead of the released share to just after the release catches up, not the reset", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [progressiveSession()],
      result: ok([window({ key: "five_hour", usedPercent: 75, resetsAt: SESSION_RESET })]),
      provider: "anthropic",
      now: NOW,
    });
    expect(wait).toMatchObject({
      usedPercent: 75,
      limitPercent: 100,
      progressive: true,
      releasedPercent: 60,
      releaseAt: "2026-09-13T12:45:00.000Z",
      usageUnknown: false,
      resetsAt: SESSION_RESET,
    });
    expect(wait!.resumeAt.toISOString()).toBe("2026-09-13T12:45:30.000Z");
    expect(wait!.reason).toBe(
      "anthropic session subscription window is at 75%, ahead of the 60% released so far of the progressive 100% limit " +
        "for company scope; enough is released at 2026-09-13T12:45:00.000Z",
    );

    // Exactly at the released share counts as ahead: the margin after "now"
    // lets the release move past the usage before the re-check.
    const atShare = decideSubscriptionWindowWait({
      policies: [progressiveSession()],
      result: ok([window({ key: "five_hour", usedPercent: 60, resetsAt: SESSION_RESET })]),
      provider: "anthropic",
      now: NOW,
    });
    expect(atShare?.resumeAt.toISOString()).toBe("2026-09-13T12:00:30.000Z");

    // Weekly: 70% releasing 10% a day, 30% used 2.5 days in, catches up at day 3.
    const week = decideSubscriptionWindowWait({
      policies: [policy({ id: "policy-week", windowKind: "provider_week", amount: 70, progressive: true })],
      result: ok([window({ key: "seven_day", usedPercent: 30, resetsAt: "2026-09-18T00:00:00.000Z" })]),
      provider: "anthropic",
      now: NOW,
    });
    expect(week?.releaseAt).toBe("2026-09-14T00:00:00.000Z");
    expect(week?.resumeAt.toISOString()).toBe("2026-09-14T00:00:30.000Z");
    expect(week?.reason).toContain("ahead of the 25% released so far of the progressive 70% limit");
  });

  it("waits for the reset once the full progressive limit is used", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [progressiveSession()],
      result: ok([window({ key: "five_hour", usedPercent: 100, resetsAt: SESSION_RESET })]),
      provider: "anthropic",
      now: NOW,
    });
    expect(wait).toMatchObject({ progressive: true, releasedPercent: 60, releaseAt: null, resetsAt: SESSION_RESET });
    expect(wait!.resumeAt.toISOString()).toBe("2026-09-13T14:00:30.000Z");
    expect(wait!.reason).toContain("(progressive limit 100% for company scope); window resets at 2026-09-13T14:00:00.000Z");
  });

  it("applies the full limit when the provider reports no reset time", () => {
    // Without a window position there is nothing to pro-rate: the ceiling
    // still holds, and usage under it proceeds as with a fixed limit.
    expect(
      decideSubscriptionWindowWait({
        policies: [policy({ amount: 80, progressive: true })],
        result: ok([window({ key: "five_hour", usedPercent: 70, resetsAt: null })]),
        provider: "anthropic",
        now: NOW,
      }),
    ).toBeNull();
    const saturated = decideSubscriptionWindowWait({
      policies: [policy({ amount: 80, progressive: true })],
      result: ok([window({ key: "five_hour", usedPercent: 85, resetsAt: null })]),
      provider: "anthropic",
      now: NOW,
      defaultWaitMs: 60_000,
    });
    expect(saturated).toMatchObject({ releasedPercent: 80, releaseAt: null, resetsAt: null });
    expect(saturated?.resumeAt.toISOString()).toBe("2026-09-13T12:01:00.000Z");
  });

  it("measures the stale-read rule against the released share", () => {
    const stale = (usedPercent: number): ProviderQuotaResult => ({
      provider: "anthropic",
      ok: true,
      stale: true,
      observedAt: "2026-09-13T11:52:00.000Z",
      error: "Anthropic OAuth usage: 429",
      windows: [window({ key: "five_hour", usedPercent, resetsAt: SESSION_RESET })],
    });
    // Under the released share a stale value cannot vouch for headroom.
    const below = decideSubscriptionWindowWait({ policies: [progressiveSession()], result: stale(50), provider: "anthropic", now: NOW, unknownWaitMs: 5 * 60_000 });
    expect(below).toMatchObject({ usageUnknown: true, usedPercent: null, releasedPercent: null });
    expect(below?.resumeAt.toISOString()).toBe("2026-09-13T12:05:00.000Z");
    // Ahead of it, usage only grows within a window, so the catch-up time is
    // a sound (tightening) wait.
    const ahead = decideSubscriptionWindowWait({ policies: [progressiveSession()], result: stale(75), provider: "anthropic", now: NOW });
    expect(ahead).toMatchObject({ usageUnknown: false, usedPercent: 75, releaseAt: "2026-09-13T12:45:00.000Z" });
  });
});

describe("judgeStaleRead", () => {
  it("clears only a young read whose drift-adjusted usage stays under the limit", () => {
    const base = { usedPercent: 40, limitPercent: 80, now: NOW, maxAgeMs: 3 * 60_000, driftPercentPerMinute: 1 };
    expect(judgeStaleRead({ ...base, observedAt: "2026-09-13T11:58:00.000Z" })).toEqual({
      clears: true,
      ageMs: 120_000,
      projectedPercent: 42,
    });
    expect(judgeStaleRead({ ...base, observedAt: "2026-09-13T11:56:00.000Z" })).toMatchObject({ clears: false, why: "too_old" });
    expect(judgeStaleRead({ ...base, usedPercent: 78.5, observedAt: "2026-09-13T11:58:00.000Z" })).toMatchObject({
      clears: false,
      why: "no_headroom",
      projectedPercent: 80.5,
    });
    expect(judgeStaleRead({ ...base, observedAt: null })).toMatchObject({ clears: false, why: "no_read_time" });
    // The strict default: no allowance at all, whatever the age or headroom.
    expect(judgeStaleRead({ ...base, maxAgeMs: 0, observedAt: "2026-09-13T11:59:00.000Z" })).toMatchObject({ clears: false, why: "disabled" });
    expect(judgeStaleRead({ usedPercent: 40, limitPercent: 80, now: NOW, observedAt: "2026-09-13T11:59:00.000Z" })).toMatchObject({ clears: false, why: "disabled" });
    // A read from the future is treated as current, never as negative age.
    expect(judgeStaleRead({ ...base, observedAt: "2026-09-13T12:01:00.000Z" })).toMatchObject({ clears: true, ageMs: 0 });
  });
});

describe("isSubscriptionUsageHeld", () => {
  it("mirrors the gate for the budget card", () => {
    expect(isSubscriptionUsageHeld({ limitPercent: 0, usedPercent: null, stale: false, observedAt: null })).toBe(false);
    expect(isSubscriptionUsageHeld({ limitPercent: 80, usedPercent: null, stale: false, observedAt: null })).toBe(true);
    expect(isSubscriptionUsageHeld({ limitPercent: 80, usedPercent: 40, stale: false, observedAt: null })).toBe(false);
    // At or above the limit the run defers to the reset: a hard stop, not a hold.
    expect(isSubscriptionUsageHeld({ limitPercent: 80, usedPercent: 90, stale: true, observedAt: "2026-09-13T11:59:00.000Z", now: NOW })).toBe(false);
    // Strict by default: a young stale read still holds.
    expect(isSubscriptionUsageHeld({ limitPercent: 80, usedPercent: 40, stale: true, observedAt: "2026-09-13T11:59:00.000Z", now: NOW })).toBe(true);
    // Opted in, a young read with headroom clears and an old one holds.
    expect(isSubscriptionUsageHeld({ limitPercent: 80, usedPercent: 40, stale: true, observedAt: "2026-09-13T11:59:00.000Z", now: NOW, staleReadMaxAgeMs: 3 * 60_000 })).toBe(false);
    expect(isSubscriptionUsageHeld({ limitPercent: 80, usedPercent: 40, stale: true, observedAt: "2026-09-13T11:50:00.000Z", now: NOW, staleReadMaxAgeMs: 3 * 60_000 })).toBe(true);
  });
});

describe("observeSubscriptionWindow", () => {
  it("reads the matching window from an ok provider result", () => {
    const result: ProviderQuotaResult = {
      provider: "anthropic",
      ok: true,
      windows: [window({ key: "seven_day", usedPercent: 42, resetsAt: "2026-09-18T00:00:00.000Z" })],
    };
    expect(observeSubscriptionWindow(result, "provider_week")).toEqual({
      usedPercent: 42,
      resetsAt: "2026-09-18T00:00:00.000Z",
      stale: false,
      observedAt: null,
    });
    expect(observeSubscriptionWindow(result, "provider_session")).toBeNull();
  });

  it("carries the snapshot's staleness and read time through", () => {
    const result: ProviderQuotaResult = {
      provider: "anthropic",
      ok: true,
      stale: true,
      observedAt: "2026-09-13T11:55:00.000Z",
      error: "Anthropic OAuth usage: 429",
      windows: [window({ key: "five_hour", usedPercent: 61 })],
    };
    expect(observeSubscriptionWindow(result, "provider_session")).toEqual({
      usedPercent: 61,
      resetsAt: null,
      stale: true,
      observedAt: "2026-09-13T11:55:00.000Z",
    });
  });

  it("returns null for a failed provider result", () => {
    expect(
      observeSubscriptionWindow({ provider: "anthropic", ok: false, error: "down", windows: [] }, "provider_week"),
    ).toBeNull();
  });
});

describe("boundSubscriptionWindowWait", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("keeps the reported resume time while the wait is inside the bound", () => {
    const waitStartedAt = new Date(NOW.getTime() - 3 * DAY_MS);
    const resumeAt = new Date(NOW.getTime() + 15 * 60 * 1000);
    const bound = boundSubscriptionWindowWait({ waitStartedAt, resumeAt, now: NOW, maxWaitMs: 8 * DAY_MS });
    expect(bound.exhausted).toBe(false);
    expect(bound.deadline.toISOString()).toBe(new Date(waitStartedAt.getTime() + 8 * DAY_MS).toISOString());
    expect(bound.resumeAt).toBe(resumeAt);
  });

  it("clamps a resume time past the deadline to the deadline", () => {
    const waitStartedAt = new Date(NOW.getTime() - 7 * DAY_MS);
    const bound = boundSubscriptionWindowWait({
      waitStartedAt,
      resumeAt: new Date("2099-01-01T00:00:00.000Z"),
      now: NOW,
      maxWaitMs: 8 * DAY_MS,
    });
    expect(bound.exhausted).toBe(false);
    expect(bound.resumeAt.toISOString()).toBe(new Date(waitStartedAt.getTime() + 8 * DAY_MS).toISOString());
  });

  it("reports exhaustion once the wait has lasted the maximum, not after a number of deferrals", () => {
    const waitStartedAt = new Date(NOW.getTime() - 8 * DAY_MS);
    const bound = boundSubscriptionWindowWait({
      waitStartedAt,
      resumeAt: new Date(NOW.getTime() + 15 * 60 * 1000),
      now: NOW,
      maxWaitMs: 8 * DAY_MS,
    });
    expect(bound.exhausted).toBe(true);

    // A weekly window re-checked every 15 minutes for six days is still a valid wait.
    const sixDays = boundSubscriptionWindowWait({
      waitStartedAt: new Date(NOW.getTime() - 6 * DAY_MS),
      resumeAt: new Date(NOW.getTime() + 15 * 60 * 1000),
      now: NOW,
      maxWaitMs: 8 * DAY_MS,
    });
    expect(sixDays.exhausted).toBe(false);
  });
});

describe("createQuotaSnapshotReader", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one fetch between concurrent callers and reuses it inside the ttl", async () => {
    const fetch = vi.fn(async (): Promise<ProviderQuotaResult[]> => [
      { provider: "anthropic", ok: true, windows: [] },
    ]);
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 60_000 });

    const [first, second] = await Promise.all([read({ now: NOW }), read({ now: NOW })]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    const within = await read({ now: new Date(NOW.getTime() + 59_000) });
    expect(within).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refetches once the ttl has elapsed", async () => {
    const fetch = vi.fn(async (): Promise<ProviderQuotaResult[]> => [
      { provider: "anthropic", ok: true, windows: [] },
    ]);
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 1_000 });
    const first = await read({ now: NOW });
    const later = await read({ now: new Date(first.fetchedAt.getTime() + 1_001) });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(later).not.toBe(first);
  });

  it("fails open by returning a not-ok snapshot instead of throwing", async () => {
    const fetch = vi.fn(async (): Promise<ProviderQuotaResult[]> => {
      throw new Error("usage endpoint unreachable");
    });
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 60_000 });
    const snapshot = await read({ now: NOW });
    expect(snapshot.results).toEqual([
      expect.objectContaining({ ok: false, error: "Error: usage endpoint unreachable", windows: [] }),
    ]);
  });

  it("stamps every ok row with the time it was read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetch = vi.fn(async (): Promise<ProviderQuotaResult[]> => [
      { provider: "anthropic", ok: true, windows: [window({ key: "five_hour", usedPercent: 12 })] },
    ]);
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 60_000 });
    const snapshot = await read({ now: NOW });
    expect(snapshot.results[0]).toMatchObject({ ok: true, observedAt: NOW.toISOString() });
    expect(snapshot.results[0]?.stale).toBeUndefined();
  });

  it("keeps the last good read of a provider when its refresh fails, marked stale with the new error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const good: ProviderQuotaResult = {
      provider: "anthropic",
      source: "anthropic-oauth",
      ok: true,
      windows: [window({ key: "five_hour", usedPercent: 40, resetsAt: "2026-09-13T15:00:00.000Z" })],
    };
    const fetch = vi
      .fn<() => Promise<ProviderQuotaResult[]>>()
      .mockResolvedValueOnce([good, { provider: "openai", ok: true, windows: [] }])
      .mockResolvedValueOnce([
        { provider: "anthropic", ok: false, error: "Claude CLI /usage: probe ended early", windows: [] },
        { provider: "openai", ok: true, windows: [] },
      ]);
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 60_000, maxStaleMs: 10 * 60_000 });

    const first = await read({ now: NOW });
    expect(first.results[0]).toMatchObject({ ok: true, observedAt: NOW.toISOString() });

    const later = new Date(NOW.getTime() + 61_000);
    vi.setSystemTime(later);
    const second = await read({ now: later });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(second.results[0]).toEqual({
      ...good,
      observedAt: NOW.toISOString(),
      stale: true,
      error: "Claude CLI /usage: probe ended early",
      errorFamily: null,
      rateLimited: false,
    });
    // The other provider refreshed fine and is not stale.
    expect(second.results[1]).toMatchObject({ provider: "openai", ok: true, observedAt: later.toISOString() });
    expect(second.results[1]?.stale).toBeUndefined();
  });

  it("reports a provider as unavailable once its last good read is older than the stale bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const failure: ProviderQuotaResult = { provider: "anthropic", ok: false, error: "down", windows: [] };
    const fetch = vi
      .fn<() => Promise<ProviderQuotaResult[]>>()
      .mockResolvedValueOnce([
        { provider: "anthropic", ok: true, windows: [window({ key: "five_hour", usedPercent: 40 })] },
      ])
      .mockResolvedValue([failure]);
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 1_000, maxStaleMs: 5_000 });

    await read({ now: NOW });
    const withinBound = new Date(NOW.getTime() + 4_000);
    vi.setSystemTime(withinBound);
    expect((await read({ now: withinBound })).results[0]).toMatchObject({ ok: true, stale: true });

    const pastBound = new Date(NOW.getTime() + 6_000);
    vi.setSystemTime(pastBound);
    expect((await read({ now: pastBound })).results[0]).toEqual(failure);

    // Once forgotten, a further failure has nothing to fall back on either.
    const later = new Date(NOW.getTime() + 8_000);
    vi.setSystemTime(later);
    expect((await read({ now: later })).results[0]).toEqual(failure);
  });

  it("retries a throttled read after a short delay, at most a few times, then waits out the ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const good: ProviderQuotaResult = {
      provider: "anthropic",
      ok: true,
      windows: [window({ key: "five_hour", usedPercent: 40 })],
    };
    const throttled: ProviderQuotaResult = {
      provider: "anthropic",
      ok: false,
      rateLimited: true,
      error: "Anthropic OAuth usage: anthropic usage api returned 429 (rate limited)",
      windows: [],
    };
    const fetch = vi
      .fn<() => Promise<ProviderQuotaResult[]>>()
      .mockResolvedValueOnce([good])
      .mockResolvedValue([throttled]);
    const read = createQuotaSnapshotReader({
      fetch,
      ttlMs: 120_000,
      maxStaleMs: 10 * 60_000,
      throttleRetryMs: 20_000,
      maxThrottleRetries: 2,
    });

    const at = async (offsetMs: number) => {
      const now = new Date(NOW.getTime() + offsetMs);
      vi.setSystemTime(now);
      return read({ now });
    };

    await at(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    // First refresh after the ttl is throttled: the last good read stands in,
    // flagged as throttled, and the next refresh comes after the short delay.
    const first = await at(120_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(first.results[0]).toMatchObject({ ok: true, stale: true, rateLimited: true, error: throttled.error });
    expect((await at(130_000)).results[0]).toMatchObject({ stale: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    await at(140_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await at(160_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    // Retries exhausted: the next refresh waits the full ttl.
    await at(180_000);
    await at(200_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    await at(280_000);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("recognises a throttled read by flag or by a 429 in the error text", () => {
    expect(isRateLimitedQuotaResult({ provider: "anthropic", ok: false, rateLimited: true, windows: [] })).toBe(true);
    expect(isRateLimitedQuotaResult({ provider: "anthropic", ok: false, error: "usage api returned 429", windows: [] })).toBe(true);
    expect(isRateLimitedQuotaResult({ provider: "anthropic", ok: false, error: "probe ended early", windows: [] })).toBe(false);
    expect(isRateLimitedQuotaResult({ provider: "anthropic", ok: true, windows: [] })).toBe(false);
  });

  it("attributes a fetch that throws outright to every known provider so their last good read stands in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetch = vi
      .fn<() => Promise<ProviderQuotaResult[]>>()
      .mockResolvedValueOnce([
        { provider: "anthropic", ok: true, windows: [window({ key: "seven_day", usedPercent: 70 })] },
      ])
      .mockRejectedValueOnce(new Error("registry exploded"));
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 1_000, maxStaleMs: 60_000 });

    await read({ now: NOW });
    const later = new Date(NOW.getTime() + 2_000);
    vi.setSystemTime(later);
    const snapshot = await read({ now: later });
    expect(snapshot.results).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        ok: true,
        stale: true,
        error: "Error: registry exploded",
        windows: [window({ key: "seven_day", usedPercent: 70 })],
      }),
    ]);
  });
});
