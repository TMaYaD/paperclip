import {
  parseConnectionBudgetKey,
  quotaWindowKeyForDuration,
  type AiConnectionUsage,
  type ProviderQuotaResult,
  type QuotaWindow,
} from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { aiConnectionService } from "./ai-connections.js";
import {
  QUOTA_SNAPSHOT_MAX_STALE_MS,
  QUOTA_SNAPSHOT_TTL_MS,
  readQuotaSnapshot as readSharedQuotaSnapshot,
  type QuotaSnapshotReader,
} from "./quota-windows.js";

/**
 * Account-wide usage windows of one AI connection, keyed by length so that
 * subscription budget rules read the same window on every provider: the
 * provider's 5-hour session, daily, weekly or monthly allowance. Model- or
 * feature-scoped limits stay out; they do not describe the account.
 */
export function usageToQuotaResult(usage: AiConnectionUsage): ProviderQuotaResult {
  const windows = new Map<string, QuotaWindow>();
  for (const entry of usage.limits) {
    if (entry.scope != null) continue;
    const key = quotaWindowKeyForDuration(entry.windowDurationSeconds);
    if (!key || entry.usedPercent == null) continue;
    const previous = windows.get(key);
    // Two account-wide limits of one length: the tighter one decides admission.
    if (previous && (previous.usedPercent ?? -1) >= entry.usedPercent) continue;
    windows.set(key, { key, label: entry.label, usedPercent: entry.usedPercent, resetsAt: entry.resetsAt, valueLabel: null });
  }
  return {
    provider: usage.provider,
    accountKey: usage.connectionId,
    source: usage.source,
    ok: usage.status === "ok",
    ...(usage.status === "ok" ? {} : { errorFamily: usage.errorCode ?? "provider_unavailable", error: usage.message }),
    rateLimited: usage.errorCode === "rate_limited",
    capturedAt: usage.checkedAt,
    windows: [...windows.values()],
  };
}

type CacheEntry = { expires: number; result: Promise<ProviderQuotaResult | null>; lastGood?: ProviderQuotaResult };
const cache = new Map<string, CacheEntry>();

export type ConnectionUsageReader = (companyId: string, key: string, grantId?: string | null) => Promise<ProviderQuotaResult | null>;

/**
 * Reads usage windows for a connection budget key. Local credentials use the
 * host's memoized provider snapshot; a managed connection is probed with its
 * own credential, memoized for the quota snapshot TTL, and keeps its last good
 * read (marked `stale`) while a refresh fails, up to the snapshot stale bound.
 */
export function createConnectionUsageReader(db: Db, deps: {
  readQuotaSnapshot?: QuotaSnapshotReader;
  readUsage?: (companyId: string, connectionId: string, grantId?: string | null) => Promise<AiConnectionUsage | null>;
  ttlMs?: number;
  maxStaleMs?: number;
} = {}): ConnectionUsageReader {
  const readSnapshot = deps.readQuotaSnapshot ?? readSharedQuotaSnapshot;
  const readUsage = deps.readUsage ?? ((companyId, connectionId, grantId) => aiConnectionService(db).budgetUsage(companyId, connectionId, grantId));
  const ttlMs = deps.ttlMs ?? QUOTA_SNAPSHOT_TTL_MS;
  const maxStaleMs = deps.maxStaleMs ?? QUOTA_SNAPSHOT_MAX_STALE_MS;
  const store = deps.readUsage ? new Map<string, CacheEntry>() : cache;
  return async (companyId, key, grantId) => {
    const parsed = parseConnectionBudgetKey(key);
    if (!parsed) return null;
    if (parsed.kind === "local") {
      const snapshot = await readSnapshot();
      return snapshot.results.find((row) => row.provider === parsed.provider && row.source !== "managed-connection") ?? null;
    }
    const cacheKey = `${companyId}:${parsed.connectionId}:${grantId ?? ""}`;
    const now = Date.now();
    const existing = store.get(cacheKey);
    if (existing && existing.expires > now) return existing.result;
    const entry: CacheEntry = { expires: now + ttlMs, result: Promise.resolve(null), lastGood: existing?.lastGood };
    entry.result = (async () => {
      let fresh: ProviderQuotaResult | null = null;
      try {
        const usage = await readUsage(companyId, parsed.connectionId, grantId);
        fresh = usage ? usageToQuotaResult(usage) : null;
      } catch {
        fresh = null;
      }
      const observedAt = new Date().toISOString();
      if (fresh?.ok) {
        const good = { ...fresh, observedAt };
        entry.lastGood = good;
        return good;
      }
      const last = entry.lastGood;
      const lastAt = last?.observedAt ? new Date(last.observedAt).getTime() : NaN;
      if (last && Number.isFinite(lastAt) && Date.now() - lastAt < maxStaleMs) {
        return { ...last, stale: true, error: fresh?.error ?? "Usage refresh failed" };
      }
      // A throttled probe re-checks sooner than the TTL.
      if (fresh?.rateLimited) entry.expires = Date.now() + Math.min(ttlMs, 20_000);
      return fresh;
    })();
    if (store.size >= 500 && !store.has(cacheKey)) store.delete(store.keys().next().value!);
    store.set(cacheKey, entry);
    return entry.result;
  };
}
