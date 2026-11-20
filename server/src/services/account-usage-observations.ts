import type { ProviderQuotaResult } from "@paperclipai/shared";

/**
 * Per-account usage state shared by every reader of one AI connection's plan
 * usage: the Costs quota cards, budget summaries and the dispatch gate. One
 * account's usage endpoint is rate limited across all of its clients (the
 * Anthropic OAuth usage endpoint allows about one read per minute), so the
 * readers share the latest good observation and back off together after a
 * 429 instead of each probing on its own schedule.
 *
 * In memory and per process, like the other quota caches. Keys are
 * `<connectionId>:<grantId>`: a connection's grants hold separate credentials.
 */
export const RATE_LIMIT_BACKOFF_MIN_MS = 2 * 60 * 1000;
export const RATE_LIMIT_BACKOFF_MAX_MS = 15 * 60 * 1000;

type AccountState = {
  latest?: ProviderQuotaResult;
  rateLimitedUntil: number;
  backoffMs: number;
};

const accounts = new Map<string, AccountState>();
const MAX_ACCOUNTS = 1000;

export function accountUsageKey(connectionId: string, grantId: string): string {
  return `${connectionId}:${grantId}`;
}

function state(key: string): AccountState {
  let entry = accounts.get(key);
  if (!entry) {
    if (accounts.size >= MAX_ACCOUNTS) accounts.delete(accounts.keys().next().value!);
    entry = { rateLimitedUntil: 0, backoffMs: 0 };
    accounts.set(key, entry);
  }
  return entry;
}

/** Records a successful read and clears any backoff. Failed reads are ignored. */
export function recordAccountUsage(key: string, result: ProviderQuotaResult, now = Date.now()): void {
  if (!result.ok) return;
  const entry = state(key);
  entry.latest = { ...result, observedAt: result.observedAt ?? new Date(now).toISOString(), stale: false };
  entry.rateLimitedUntil = 0;
  entry.backoffMs = 0;
}

/**
 * Starts or extends the shared backoff after the provider answered 429. Each
 * consecutive 429 doubles the wait, from 2 to 15 minutes; a provider
 * `Retry-After` longer than that wins.
 */
export function noteAccountRateLimited(key: string, now = Date.now(), retryAfterMs?: number | null): number {
  const entry = state(key);
  entry.backoffMs = Math.min(RATE_LIMIT_BACKOFF_MAX_MS, entry.backoffMs ? entry.backoffMs * 2 : RATE_LIMIT_BACKOFF_MIN_MS);
  const wait = Math.max(entry.backoffMs, retryAfterMs != null && Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
  entry.rateLimitedUntil = Math.max(entry.rateLimitedUntil, now + wait);
  return entry.rateLimitedUntil;
}

/** When the account may be probed again, or 0 when it is not backing off. */
export function accountRateLimitedUntil(key: string, now = Date.now()): number {
  const until = accounts.get(key)?.rateLimitedUntil ?? 0;
  return until > now ? until : 0;
}

/**
 * The latest good observation of the account, if any. With `connectionId`
 * only, the newest observation across that connection's grants.
 */
export function latestAccountUsage(key: string): ProviderQuotaResult | undefined;
export function latestAccountUsage(key: { connectionId: string }): ProviderQuotaResult | undefined;
export function latestAccountUsage(key: string | { connectionId: string }): ProviderQuotaResult | undefined {
  if (typeof key === "string") return accounts.get(key)?.latest;
  let newest: ProviderQuotaResult | undefined;
  for (const [candidate, entry] of accounts) {
    if (!candidate.startsWith(`${key.connectionId}:`) || !entry.latest) continue;
    if (!newest || (entry.latest.observedAt ?? "") > (newest.observedAt ?? "")) newest = entry.latest;
  }
  return newest;
}

/** Whether any grant of the connection is backing off. */
export function connectionRateLimitedUntil(connectionId: string, now = Date.now()): number {
  let until = 0;
  for (const [candidate, entry] of accounts) {
    if (candidate.startsWith(`${connectionId}:`) && entry.rateLimitedUntil > now) until = Math.max(until, entry.rateLimitedUntil);
  }
  return until;
}

/** Test helper: forget all accounts. */
export function resetAccountUsageObservations(): void {
  accounts.clear();
}
