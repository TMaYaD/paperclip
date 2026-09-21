import { mapCodexRpcQuota, readCodexAuthInfo } from "@paperclipai/adapter-codex-local/server";
import type { ProviderQuotaResult } from "@paperclipai/shared";

/** A bucket notification is a snapshot, not an incremental percentage delta. */
export function normalizeCodexQuotaObservation(info: Record<string, unknown>): ProviderQuotaResult | null {
  // Passive notifications must identify the bucket. Never infer an account
  // bucket from an unlabelled event or a model/reserve bucket.
  if (info.limitId !== "codex") return null;
  const window = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const w = value as Record<string, unknown>;
    if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) return null;
    if (w.windowDurationMins !== 300 && w.windowDurationMins !== 10_080) return null;
    return {
      usedPercent: w.usedPercent,
      windowDurationMins: w.windowDurationMins,
      resetsAt: typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt : null,
    };
  };
  const windows = mapCodexRpcQuota({ rateLimits: {
    limitId: "codex", primary: window(info.primary), secondary: window(info.secondary),
  } }).windows;
  if (!windows.length) return null;
  return { provider: "openai", source: "codex-run-stream", ok: true, windows };
}

/** Isolated for deterministic tests. Account IDs never leave this in-memory store. */
export function createCodexQuotaObservationStore(options: {
  readAccount?: (home?: string) => Promise<string | null>;
} = {}) {
  const readAccount = options.readAccount ?? (async (home) => (await readCodexAuthInfo(home))?.accountId ?? null);
  let latest: { accountId: string; result: ProviderQuotaResult; at: number } | null = null;
  let generation = 0;
  return {
    async observe(input: { info: Record<string, unknown>; observedAt: string; codexHome?: string }, now = new Date()) {
      const result = normalizeCodexQuotaObservation(input.info);
      const at = Date.parse(input.observedAt);
      if (!result || !Number.isFinite(at) || at > now.getTime() || now.getTime() - at > 120_000) return null;
      const currentGeneration = ++generation;
      const [accountId, runAccountId] = await Promise.all([readAccount(), readAccount(input.codexHome)]);
      if (!accountId || accountId !== runAccountId || currentGeneration !== generation) return null;
      if (latest?.accountId === accountId && at <= latest.at) return null;
      const observed = { ...result, observedAt: new Date(at).toISOString() };
      latest = { accountId, result: observed, at };
      return observed;
    },
    async read(maxAgeMs: number, now = new Date()): Promise<ProviderQuotaResult | null> {
      const entry = latest;
      if (!entry || now.getTime() - entry.at >= maxAgeMs) return null;
      // An auth/account switch invalidates observations from the prior account.
      if (await readAccount() !== entry.accountId) {
        if (latest === entry) latest = null;
        return null;
      }
      // Reset boundaries also end freshness even while the age is small.
      if (entry.result.windows.some((w) => !w.resetsAt || Date.parse(w.resetsAt) <= now.getTime())) return null;
      return entry.result;
    },
  };
}

export const codexQuotaObservations = createCodexQuotaObservationStore();
