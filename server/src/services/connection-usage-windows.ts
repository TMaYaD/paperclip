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
  accountRateLimitedUntil,
  accountUsageKey,
  connectionRateLimitedUntil,
  latestAccountUsage,
  noteAccountRateLimited,
  recordAccountUsage,
} from "./account-usage-observations.js";
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

const inFlight = new Map<string, Promise<ProviderQuotaResult | null>>();

export type ConnectionUsageReader = (companyId: string, key: string, grantId?: string | null) => Promise<ProviderQuotaResult | null>;

function staleOrNull(last: ProviderQuotaResult | undefined, maxStaleMs: number, now: number, error: string, rateLimited = false): ProviderQuotaResult | null {
  const lastAt = last?.observedAt ? new Date(last.observedAt).getTime() : NaN;
  if (last && Number.isFinite(lastAt) && now - lastAt < maxStaleMs) return { ...last, stale: true, error };
  return rateLimited ? { provider: last?.provider ?? "", ok: false, rateLimited: true, errorFamily: "rate_limited", error, windows: [] } : null;
}

/**
 * Reads usage windows for a connection budget key. Local credentials use the
 * host's memoized provider snapshot. A managed connection is probed with its
 * own credential through `usageDb`, which must be the root database, never a
 * caller's transaction: reading a credential records its use, which a
 * read-only snapshot rejects and which would abort the caller's transaction.
 * Without `usageDb` (and no injected `readUsage`) only shared observations are
 * returned.
 *
 * Observations and 429 backoff are shared per account with the Costs quota
 * cards (see account-usage-observations.ts): a fresh shared read is reused,
 * a backing-off account is not probed, and the last good read is returned,
 * marked `stale`, while refreshes fail, up to the snapshot stale bound.
 */
export function createConnectionUsageReader(usageDb: Db | null, deps: {
  readQuotaSnapshot?: QuotaSnapshotReader;
  readUsage?: (companyId: string, connectionId: string, grantId?: string | null) => Promise<AiConnectionUsage | null>;
  ttlMs?: number;
  maxStaleMs?: number;
  now?: () => number;
} = {}): ConnectionUsageReader {
  const readSnapshot = deps.readQuotaSnapshot ?? readSharedQuotaSnapshot;
  const readUsage = deps.readUsage
    ?? (usageDb ? (companyId: string, connectionId: string, grantId?: string | null) => aiConnectionService(usageDb).budgetUsage(companyId, connectionId, grantId) : null);
  const ttlMs = deps.ttlMs ?? QUOTA_SNAPSHOT_TTL_MS;
  const maxStaleMs = deps.maxStaleMs ?? QUOTA_SNAPSHOT_MAX_STALE_MS;
  const clock = deps.now ?? Date.now;
  const pending = deps.readUsage ? new Map<string, Promise<ProviderQuotaResult | null>>() : inFlight;
  return async (companyId, key, grantId) => {
    const parsed = parseConnectionBudgetKey(key);
    if (!parsed) return null;
    if (parsed.kind === "local") {
      const snapshot = await readSnapshot();
      return snapshot.results.find((row) => row.provider === parsed.provider && row.source !== "managed-connection") ?? null;
    }
    const connectionId = parsed.connectionId;
    const shared = grantId ? latestAccountUsage(accountUsageKey(connectionId, grantId)) : latestAccountUsage({ connectionId });
    const now = clock();
    const sharedAt = shared?.observedAt ? new Date(shared.observedAt).getTime() : NaN;
    if (shared && Number.isFinite(sharedAt) && now - sharedAt < ttlMs) return shared;
    const limitedUntil = grantId ? accountRateLimitedUntil(accountUsageKey(connectionId, grantId), now) : connectionRateLimitedUntil(connectionId, now);
    if (limitedUntil) return staleOrNull(shared, maxStaleMs, now, "The provider rate limited the usage check.", true);
    if (!readUsage) return staleOrNull(shared, maxStaleMs, now, "Usage not read in this context");
    const cacheKey = `${companyId}:${connectionId}:${grantId ?? ""}`;
    const existing = pending.get(cacheKey);
    if (existing) return existing;
    const read = (async () => {
      let usage: AiConnectionUsage | null = null;
      try { usage = await readUsage(companyId, connectionId, grantId); }
      catch { usage = null; }
      const result = usage ? usageToQuotaResult(usage) : null;
      const accountKey = usage ? accountUsageKey(usage.connectionId, usage.grantId) : null;
      if (result?.ok && accountKey) {
        recordAccountUsage(accountKey, result, clock());
        return latestAccountUsage(accountKey) ?? result;
      }
      if (result?.rateLimited && accountKey) {
        noteAccountRateLimited(accountKey, clock());
        return staleOrNull(shared, maxStaleMs, clock(), result.error ?? "The provider rate limited the usage check.", true);
      }
      return staleOrNull(shared, maxStaleMs, clock(), result?.error ?? "Usage refresh failed") ?? result;
    })().finally(() => pending.delete(cacheKey));
    if (pending.size >= 500 && !pending.has(cacheKey)) pending.delete(pending.keys().next().value!);
    pending.set(cacheKey, read);
    return read;
  };
}
