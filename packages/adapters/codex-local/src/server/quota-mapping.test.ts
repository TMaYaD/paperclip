import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCodexQuota, mapCodexRpcQuota } from "./quota.js";

// Allowlisted fields captured from Codex 0.155.1 on 2026-09-21. No auth data.
const weekly = { usedPercent: 8, windowDurationMins: 10_080, resetsAt: 1_790_502_487 };
const session = { usedPercent: 0.5, windowDurationMins: 300, resetsAt: 1_789_956_000 };
const resetIso = "2026-09-27T09:48:07.000Z";

afterEach(() => vi.unstubAllGlobals());

describe("Codex quota identities", () => {
  it("maps the captured weekly-only account and keeps reserve usage out of budgets", () => {
    const codex = { limitId: "codex", primary: weekly, secondary: null };
    const result = mapCodexRpcQuota({
      rateLimits: codex,
      rateLimitsByLimitId: {
        base_model_inference: { limitId: "base_model_inference", limitName: "gpt-reserve", primary: { ...weekly, usedPercent: 0 } },
        codex,
      },
    });
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toMatchObject({ key: "seven_day", label: "Weekly limit", usedPercent: 8, resetsAt: resetIso });
    expect(result.windows[1]).toMatchObject({ key: null, label: "gpt-reserve · Weekly limit" });
    expect(result.windows.some((w) => w.key === "five_hour")).toBe(false);
  });

  it.each([[session, weekly], [weekly, session]])("identifies windows independently of slot order", (primary, secondary) => {
    const { windows } = mapCodexRpcQuota({ rateLimits: { limitId: "codex", primary, secondary } });
    expect(windows.find((w) => w.key === "five_hour")?.usedPercent).toBe(0.5);
    expect(windows.find((w) => w.key === "seven_day")?.usedPercent).toBe(8);
  });

  it("prefers the keyed account bucket over the legacy view", () => {
    const { windows } = mapCodexRpcQuota({
      rateLimits: { limitId: "codex", primary: { ...session, usedPercent: 99 } },
      rateLimitsByLimitId: { codex: { limitId: "codex", primary: weekly } },
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ key: "seven_day", usedPercent: 8 });
  });

  it("does not promote a special-purpose root or conflicting bucket identity", () => {
    for (const result of [
      { rateLimits: { limitId: "codex_review", primary: session, secondary: weekly } },
      { rateLimitsByLimitId: { codex: { limitId: "codex_review", primary: session, secondary: weekly } } },
    ]) {
      expect(mapCodexRpcQuota(result).windows.map((w) => w.key)).toEqual([null, null]);
    }
  });

  it("supports the legacy account view without limitId, but requires explicit duration", () => {
    expect(mapCodexRpcQuota({ rateLimits: { primary: weekly } }).windows[0]?.key).toBe("seven_day");
    for (const duration of [undefined, null, 15, 60, 1440, 78000, 0, -300, NaN]) {
      const { windows } = mapCodexRpcQuota({ rateLimits: { primary: { ...weekly, windowDurationMins: duration } } });
      expect(windows[0]?.key).toBeNull();
      expect(windows[0]?.label).not.toBe("5h limit");
    }
  });

  it("does not turn fractional percentages into ratios or throw on invalid reset dates", () => {
    const { windows } = mapCodexRpcQuota({ rateLimits: {
      primary: { ...session, resetsAt: Number.MAX_VALUE },
      secondary: { ...weekly, usedPercent: NaN },
    } });
    expect(windows[0]).toMatchObject({ usedPercent: 0.5, resetsAt: null });
    expect(windows[1]?.usedPercent).toBeNull();
  });

  it.each([[weekly, null], [session, weekly], [weekly, session]])("matches HTTP and RPC normalization", async (primary, secondary) => {
    const wham = (w: typeof weekly | null) => w && ({
      used_percent: w.usedPercent,
      limit_window_seconds: w.windowDurationMins * 60,
      reset_at: w.resetsAt,
      // Relative seconds are not an epoch timestamp or the window duration.
      reset_after_seconds: 555446,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      rate_limit: { primary_window: wham(primary), secondary_window: wham(secondary) },
      additional_rate_limits: [{ metered_feature: "base_model_inference", rate_limit: { primary_window: wham(session) } }],
    }) }));
    expect(await fetchCodexQuota("fixture-token", null)).toEqual(
      mapCodexRpcQuota({ rateLimits: { limitId: "codex", primary, secondary } }).windows,
    );
  });
});
