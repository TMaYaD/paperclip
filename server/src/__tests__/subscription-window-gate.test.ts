import { describe, expect, it, vi } from "vitest";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import {
  decideSubscriptionWindowWait,
  observeSubscriptionWindow,
  type SubscriptionWindowPolicy,
} from "../services/subscription-window-gate.ts";
import { createQuotaSnapshotReader } from "../services/quota-windows.ts";

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
    ...overrides,
  };
}

describe("decideSubscriptionWindowWait", () => {
  it("returns null while usage is below every policy limit", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [policy(), policy({ id: "policy-week", windowKind: "provider_week", amount: 90 })],
      windows: [
        window({ key: "five_hour", usedPercent: 79, resetsAt: "2026-09-13T14:00:00.000Z" }),
        window({ key: "seven_day", usedPercent: 50, resetsAt: "2026-09-18T00:00:00.000Z" }),
      ],
      provider: "anthropic",
      now: NOW,
    });
    expect(wait).toBeNull();
  });

  it("defers to just after the window reset when usage reaches the limit", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [policy()],
      windows: [window({ key: "five_hour", usedPercent: 80, resetsAt: "2026-09-13T14:00:00.000Z" })],
      provider: "anthropic",
      now: NOW,
    });
    expect(wait).toMatchObject({
      policyId: "policy-session",
      windowKind: "provider_session",
      quotaKey: "five_hour",
      provider: "anthropic",
      usedPercent: 80,
      limitPercent: 80,
      resetsAt: "2026-09-13T14:00:00.000Z",
    });
    expect(wait!.resumeAt.toISOString()).toBe("2026-09-13T14:00:30.000Z");
    expect(wait!.reason).toContain("session subscription window is at 80%");
  });

  it("falls back to the default wait when the provider reports no usable reset time", () => {
    const stale = decideSubscriptionWindowWait({
      policies: [policy()],
      windows: [window({ key: "five_hour", usedPercent: 95, resetsAt: "2026-09-13T11:00:00.000Z" })],
      provider: "anthropic",
      now: NOW,
      defaultWaitMs: 60_000,
    });
    expect(stale?.resetsAt).toBeNull();
    expect(stale?.resumeAt.toISOString()).toBe("2026-09-13T12:01:00.000Z");

    const missing = decideSubscriptionWindowWait({
      policies: [policy()],
      windows: [window({ key: "five_hour", usedPercent: 95, resetsAt: null })],
      provider: "anthropic",
      now: NOW,
      defaultWaitMs: 60_000,
    });
    expect(missing?.resumeAt.toISOString()).toBe("2026-09-13T12:01:00.000Z");
  });

  it("waits for the latest reset when both the session and the week block", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [policy(), policy({ id: "policy-week", windowKind: "provider_week", amount: 90 })],
      windows: [
        window({ key: "five_hour", usedPercent: 100, resetsAt: "2026-09-13T14:00:00.000Z" }),
        window({ key: "seven_day", usedPercent: 91, resetsAt: "2026-09-18T00:00:00.000Z" }),
      ],
      provider: "anthropic",
      now: NOW,
    });
    expect(wait?.policyId).toBe("policy-week");
    expect(wait?.resumeAt.toISOString()).toBe("2026-09-18T00:00:30.000Z");
  });

  it("never blocks on a window the provider did not report or reported without utilization", () => {
    expect(
      decideSubscriptionWindowWait({
        policies: [policy()],
        windows: [window({ key: "seven_day", usedPercent: 100 })],
        provider: "anthropic",
        now: NOW,
      }),
    ).toBeNull();
    expect(
      decideSubscriptionWindowWait({
        policies: [policy()],
        windows: [window({ key: "five_hour", usedPercent: null })],
        provider: "anthropic",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("ignores policies with a zero limit and matches windows by key, not label", () => {
    expect(
      decideSubscriptionWindowWait({
        policies: [policy({ amount: 0 })],
        windows: [window({ key: "five_hour", usedPercent: 100 })],
        provider: "anthropic",
        now: NOW,
      }),
    ).toBeNull();
    expect(
      decideSubscriptionWindowWait({
        policies: [policy()],
        windows: [window({ key: null, label: "Current session", usedPercent: 100 })],
        provider: "anthropic",
        now: NOW,
      }),
    ).toBeNull();
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
    });
    expect(observeSubscriptionWindow(result, "provider_session")).toBeNull();
  });

  it("returns null for a failed provider result", () => {
    expect(
      observeSubscriptionWindow({ provider: "anthropic", ok: false, error: "down", windows: [] }, "provider_week"),
    ).toBeNull();
  });
});

describe("createQuotaSnapshotReader", () => {
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
});
