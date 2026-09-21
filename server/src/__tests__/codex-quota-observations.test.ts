import { nativeCodexQuotaObservation } from "../services/native-runtime/codex-quota-observation.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexQuotaObservationStore, normalizeCodexQuotaObservation } from "../services/codex-quota-observations.js";
import { createQuotaSnapshotReader } from "../services/quota-windows.js";

const now = new Date("2026-09-21T12:00:00Z");
const info = { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: now.getTime() / 1000 + 86400 }, secondary: null };
const observation = { info, observedAt: now.toISOString(), codexHome: "/agent-home" };
const makeStore = () => createCodexQuotaObservationStore({ readAccount: async () => "same-account" });
afterEach(() => vi.useRealTimers());

describe("passive Codex quota observations", () => {
  it("accepts the same account and expires after inactivity or reset", async () => {
    const store = makeStore();
    expect(await store.observe(observation, now)).toMatchObject({ source: "codex-run-stream", windows: [{ key: "seven_day", usedPercent: 12 }] });
    expect(await store.read(120000, new Date(now.getTime() + 119999))).not.toBeNull();
    expect(await store.read(120000, new Date(now.getTime() + 120000))).toBeNull();
    expect(await store.read(7 * 86400000, new Date(now.getTime() + 86400000))).toBeNull();
  });

  it("rejects other accounts, unknown accounts and a host account switch", async () => {
    let host = "host";
    const store = createCodexQuotaObservationStore({ readAccount: async (home) => home ? "agent" : host });
    expect(await store.observe(observation, now)).toBeNull();
    host = "agent";
    expect(await store.observe(observation, now)).not.toBeNull();
    host = "new-host";
    expect(await store.read(120000, now)).toBeNull();
    const unknown = createCodexQuotaObservationStore({ readAccount: async () => null });
    expect(await unknown.observe(observation, now)).toBeNull();
  });

  it("does not renew freshness for reserve buckets, malformed windows or replay", async () => {
    const store = makeStore();
    await store.observe(observation, now);
    expect(await store.observe({ ...observation, info: { ...info, limitId: "base_model_inference" }, observedAt: new Date(now.getTime() + 60000).toISOString() }, new Date(now.getTime() + 60000))).toBeNull();
    expect(await store.observe(observation, new Date(now.getTime() + 90000))).toBeNull();
    expect(await store.read(120000, new Date(now.getTime() + 120001))).toBeNull();
    expect(normalizeCodexQuotaObservation({ ...info, primary: { ...info.primary, usedPercent: NaN } })).toBeNull();
    expect(normalizeCodexQuotaObservation({ primary: info.primary })).toBeNull();
    expect(normalizeCodexQuotaObservation({ ...info, primary: { ...info.primary, windowDurationMins: 60 } })).toBeNull();
    expect(await makeStore().observe({ ...observation, observedAt: new Date(now.getTime() + 1).toISOString() }, now)).toBeNull();
    expect(await makeStore().observe(observation, new Date(now.getTime() + 120001))).toBeNull();
  });

  it("does not retain an old session window when the new account snapshot reports only weekly", async () => {
    const store = makeStore();
    await store.observe({ ...observation, info: { ...info, secondary: { ...info.primary, windowDurationMins: 300 } } }, now);
    const later = new Date(now.getTime() + 1000);
    await store.observe({ ...observation, observedAt: later.toISOString() }, later);
    expect((await store.read(120000, later))?.windows.map((w) => w.key)).toEqual(["seven_day"]);
  });

  it("strips arbitrary metadata rather than forwarding secrets", () => {
    const result = normalizeCodexQuotaObservation({ ...info, token: "secret-marker", primary: { ...info.primary, secret: "secret-marker" } });
    expect(JSON.stringify(result)).not.toContain("secret-marker");
  });

  it("refreshes at the passive reset boundary even before the normal poll TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const result = normalizeCodexQuotaObservation({ ...info, primary: { ...info.primary, resetsAt: now.getTime() / 1000 + 1 } })!;
    const fetch = vi.fn().mockResolvedValue([{ ...result, observedAt: now.toISOString() }]);
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 120000 });
    await read();
    expect(fetch).toHaveBeenCalledOnce();
    vi.setSystemTime(now.getTime() + 1000);
    await read();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps newer run observations when an older poll finishes, and retains the original age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let finish!: (value: any[]) => void;
    const read = createQuotaSnapshotReader({ fetch: () => new Promise((resolve) => { finish = resolve; }) });
    const polling = read();
    vi.setSystemTime(now.getTime() + 1000);
    const live = { ...normalizeCodexQuotaObservation(info)!, observedAt: new Date().toISOString() };
    read.observe!(live);
    finish([{ provider: "openai", ok: true, windows: [] }]);
    expect((await polling).results[0]).toEqual(live);
    expect((await read()).results[0]).toEqual(live);
  });
});


describe("native Codex quota event forwarding", () => {
  it("preserves the producer timestamp and rejects unrelated event sources", () => {
    const event = { sourceKind: "runner" as const, eventType: "harness.diagnostic", emittedAt: now.toISOString(), payload: { code: "codex_quota_updated", rateLimits: info } };
    expect(nativeCodexQuotaObservation("codex", event)).toEqual({ kind: "codex_rate_limits", info, observedAt: now.toISOString() });
    expect(nativeCodexQuotaObservation("claude_managed", event)).toBeNull();
    expect(nativeCodexQuotaObservation("codex", { ...event, sourceKind: "control_plane" })).toBeNull();
    expect(nativeCodexQuotaObservation("codex", { ...event, eventType: "item.completed" })).toBeNull();
    expect(nativeCodexQuotaObservation("codex", { ...event, payload: { code: "other" } })).toBeNull();
  });
});
