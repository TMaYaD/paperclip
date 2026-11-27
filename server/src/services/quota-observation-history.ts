import type { ProviderQuotaResult } from "@paperclipai/shared";
import { aiQuotaObservations, type Db } from "@paperclipai/db";
import { and, eq, lt } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

/**
 * Keeps a history of managed AI connections' plan-usage windows.
 *
 * Providers report plan usage only as a percentage of an undisclosed
 * allowance, and their usage endpoints are rate limited, so this never reads
 * the provider itself: the quota readers that already probe an account (the
 * Costs quota cards and subscription budget gates) hand each successful read
 * to `recordQuotaObservation`. An unchanged reading is kept at most once per
 * `UNCHANGED_KEEP_MS`; a changed percentage or reset time is kept at once.
 * Rows older than `RETENTION_MS` are deleted while writing, at most once a
 * day per connection, so nothing runs while no account is being read.
 *
 * Recording is best effort: a failed write is logged and never fails the
 * quota read that produced it.
 */
export const UNCHANGED_KEEP_MS = 30 * 60 * 1000;
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED = 2000;

type Kept = { usedPercent: number; resetsAt: string | null; at: number };
const lastKept = new Map<string, Kept>();
const lastPruned = new Map<string, number>();

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  if (map.size >= MAX_TRACKED) map.delete(map.keys().next().value!);
  map.set(key, value);
}

function normalizedResetsAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export async function recordQuotaObservation(db: Db, input: {
  companyId: string;
  connectionId: string;
  grantId?: string | null;
  result: ProviderQuotaResult;
  now?: number;
}): Promise<number> {
  const { companyId, connectionId, result } = input;
  if (!result.ok || result.stale) return 0;
  const grantId = input.grantId ?? null;
  const now = input.now ?? Date.now();
  const reported = result.observedAt ?? result.capturedAt;
  const observedMs = reported ? new Date(reported).getTime() : NaN;
  const observedAt = new Date(Number.isFinite(observedMs) ? observedMs : now);
  const rows: (typeof aiQuotaObservations.$inferInsert)[] = [];
  const kept: [string, Kept][] = [];
  for (const window of result.windows) {
    const usedPercent = window.usedPercent;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    const resetsAt = normalizedResetsAt(window.resetsAt);
    const key = `${companyId}:${connectionId}:${grantId ?? ""}:${window.key}`;
    const previous = lastKept.get(key);
    if (previous && previous.usedPercent === usedPercent && previous.resetsAt === resetsAt && now - previous.at < UNCHANGED_KEEP_MS) continue;
    rows.push({
      companyId, connectionId, grantId, provider: result.provider,
      windowKey: window.key, windowLabel: window.label ?? null,
      usedPercent, resetsAt: resetsAt ? new Date(resetsAt) : null, observedAt,
    });
    kept.push([key, { usedPercent, resetsAt, at: now }]);
  }
  if (!rows.length) return 0;
  const warn = (error: unknown, message: string) => logger.warn({ companyId, connectionId, provider: result.provider,
    err: error instanceof Error ? error.message : String(error) }, message);
  try {
    await db.insert(aiQuotaObservations).values(rows);
  } catch (error) {
    warn(error, "Could not record quota observation");
    return 0;
  }
  for (const [key, value] of kept) remember(lastKept, key, value);
  const pruneKey = `${companyId}:${connectionId}`;
  if (now - (lastPruned.get(pruneKey) ?? 0) >= PRUNE_EVERY_MS) {
    remember(lastPruned, pruneKey, now);
    try {
      await db.delete(aiQuotaObservations).where(and(
        eq(aiQuotaObservations.companyId, companyId),
        eq(aiQuotaObservations.connectionId, connectionId),
        lt(aiQuotaObservations.observedAt, new Date(now - RETENTION_MS)),
      ));
    } catch (error) {
      warn(error, "Could not prune quota observations");
    }
  }
  return rows.length;
}

/** Test helper: forget dedupe and pruning state. */
export function resetQuotaObservationHistory(): void {
  lastKept.clear();
  lastPruned.clear();
}
