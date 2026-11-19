import { describe, expect, it, vi } from "vitest";
import type { AiConnectionMetadata, AiConnectionUsage } from "@paperclipai/shared";
import { probeAiConnectionUsage } from "./ai-connection-usage.js";
import { createConnectionUsageReader, usageToQuotaResult } from "./connection-usage-windows.js";

const gateway = (baseUrl: string): AiConnectionMetadata => ({
  provider: "anthropic", method: "subscription",
  routing: { kind: "gateway", protocol: "messages", baseUrl, auth: "bearer", models: [] },
});
const json = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
const RESET = 1_795_000_000_000;

describe("gateway usage probes", () => {
  it("reads MiniMax plan windows, treating usage counts as remaining quota", async () => {
    const request = json({
      base_resp: { status_code: 0 },
      model_remains: [{ model_name: "MiniMax-M2", end_time: RESET, weekly_end_time: RESET + 86_400_000,
        current_interval_total_count: 1000, current_interval_usage_count: 250,
        current_weekly_total_count: 5000, current_weekly_usage_count: 4000 }],
    });
    const usage = await probeAiConnectionUsage(gateway("https://api.minimax.io/anthropic"), "sk-cp-test", { request });
    expect(request).toHaveBeenCalledWith("https://api.minimax.io/v1/token_plan/remains", expect.objectContaining({ headers: { Authorization: "Bearer sk-cp-test" } }));
    expect(usage.status).toBe("ok");
    expect(usage.limits.map((entry) => [entry.windowDurationSeconds, entry.usedPercent, entry.resetsAt])).toEqual([
      [18000, 75, new Date(RESET).toISOString()],
      [604800, 20, new Date(RESET + 86_400_000).toISOString()],
    ]);
  });

  it("prefers MiniMax remaining percentages and rejects a wrong-region answer", async () => {
    const percent = await probeAiConnectionUsage(gateway("https://api.minimaxi.com/anthropic"), "key", { request: json({
      base_resp: { status_code: 0 },
      model_remains: [{ end_time: RESET, current_interval_total_count: 0, current_interval_usage_count: 0, current_interval_remaining_percent: 35 }],
    }) });
    expect(percent.limits[0].usedPercent).toBe(65);
    const wrongRegion = await probeAiConnectionUsage(gateway("https://api.minimax.io/anthropic"), "key", { request: json({ base_resp: { status_code: 1004 } }) });
    expect(wrongRegion).toMatchObject({ status: "unavailable", errorCode: "authentication_required" });
  });

  it("reads Z.ai token windows without a Bearer prefix", async () => {
    const request = json({ success: true, data: { level: "pro", limits: [
      { type: "TOKENS_LIMIT", percentage: 12, nextResetTime: RESET },
      { type: "TIME_LIMIT", percentage: 99 },
      { type: "TOKENS_LIMIT", percentage: 40, nextResetTime: RESET + 1 },
    ] } });
    const usage = await probeAiConnectionUsage(gateway("https://api.z.ai/api/anthropic"), "zai-key", { request });
    expect(request).toHaveBeenCalledWith("https://api.z.ai/api/monitor/usage/quota/limit", expect.objectContaining({ headers: { Authorization: "zai-key" } }));
    expect(usage.limits.map((entry) => [entry.windowDurationSeconds, entry.usedPercent])).toEqual([[18000, 12], [604800, 40]]);
  });

  it("reads Kimi weekly and windowed limits", async () => {
    const usage = await probeAiConnectionUsage(gateway("https://api.kimi.com/coding"), "kimi-key", { request: json({
      usage: { limit: "100", used: "30", remaining: "70", resetTime: "2026-11-25T00:00:00Z" },
      limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "10", used: "9", remaining: "1", resetTime: "2026-11-20T00:00:00Z" } }],
    }) });
    expect(usage.limits.map((entry) => [entry.windowDurationSeconds, entry.usedPercent])).toEqual([[604800, 30], [18000, 90]]);
  });

  it("leaves other gateways unsupported", async () => {
    const usage = await probeAiConnectionUsage(gateway("https://gateway.example.com/anthropic"), "key", { request: json({}) });
    expect(usage.status).toBe("unsupported");
  });
});

const usage = (overrides: Partial<AiConnectionUsage>): AiConnectionUsage => ({
  connectionId: "c", grantId: "g", provider: "anthropic", method: "subscription", status: "ok", checkedAt: new Date().toISOString(),
  source: "test", planType: null, overage: null, limits: [], ...overrides,
});
const entry = (windowDurationSeconds: number | null, usedPercent: number | null, scope: string | null = null) => ({
  id: `${windowDurationSeconds}-${scope}`, label: "l", scope, windowDurationSeconds, resetsAt: null, usedPercent,
  remainingPercent: null, used: null, limit: null, remaining: null, unit: null, limitReached: null, allowed: null,
});

describe("connection usage windows", () => {
  it("keys account-wide limits by length and keeps the tighter of two", () => {
    const result = usageToQuotaResult(usage({ limits: [entry(18000, 20), entry(18000, 60), entry(604800, 10, "opus"), entry(86400, 5), entry(30 * 86400, 70)] }));
    expect(result.ok).toBe(true);
    expect(result.windows.map((window) => [window.key, window.usedPercent])).toEqual([["five_hour", 60], ["one_day", 5], ["thirty_day", 70]]);
  });

  it("keeps the last good read while a refresh fails", async () => {
    let ok = true;
    const read = createConnectionUsageReader({} as never, {
      ttlMs: 0,
      readUsage: async () => ok ? usage({ limits: [entry(18000, 40)] }) : usage({ status: "error", errorCode: "provider_unavailable", message: "down" }),
    });
    expect((await read("co", "8e4f0f9c-0a1b-4c55-9b8a-2b6f5e1d7c11"))?.windows[0].usedPercent).toBe(40);
    ok = false;
    const stale = await read("co", "8e4f0f9c-0a1b-4c55-9b8a-2b6f5e1d7c11");
    expect(stale).toMatchObject({ ok: true, stale: true });
    expect(stale?.windows[0].usedPercent).toBe(40);
  });

  it("reads local credentials from the host snapshot of that provider only", async () => {
    const read = createConnectionUsageReader({} as never, {
      readQuotaSnapshot: async () => ({ fetchedAt: new Date(), results: [
        { provider: "anthropic", ok: true, windows: [] },
        { provider: "openai", ok: true, windows: [{ key: "five_hour", label: "5h", usedPercent: 9, resetsAt: null, valueLabel: null }] },
      ] }),
    });
    expect((await read("co", "local:openai"))?.windows[0].usedPercent).toBe(9);
    expect(await read("co", "local:google")).toBeNull();
  });
});
