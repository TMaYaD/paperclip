import { and, eq, gt, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { budgetPolicies } from "@paperclipai/db";
import {
  SUBSCRIPTION_BUDGET_WINDOW_QUOTA_KEYS,
  isSubscriptionBudgetWindowKind,
  type BudgetScopeType,
  type ProviderQuotaResult,
  type QuotaWindow,
  type SubscriptionBudgetWindowKind,
} from "@paperclipai/shared";
import {
  providerSlugForAdapterType,
  readQuotaSnapshot as readSharedQuotaSnapshot,
  type QuotaSnapshotReader,
} from "./quota-windows.js";

/**
 * Subscription window gate.
 *
 * A `subscription_percent` budget policy says: "do not start new runs for this
 * scope while the provider's subscription window (session or week) is at or
 * above N% used". Unlike a `billed_cents` hard stop, crossing the threshold is
 * not an incident and never pauses the scope: the window resets on its own, so
 * the queued run is *deferred* to the reset time and promoted again by the
 * ordinary scheduled-retry loop. Nothing in this path asks the board for help.
 */

/** `heartbeat_runs.scheduled_retry_reason` for a run deferred by this gate. */
export const SUBSCRIPTION_WINDOW_WAIT_RETRY_REASON = "subscription_window_wait";
/** `heartbeat_runs.error_code` for a timer heartbeat skipped by this gate. */
export const SUBSCRIPTION_WINDOW_SKIPPED_ERROR_CODE = "subscription_window_skipped";
/** `heartbeat_runs.error_code` when a run was deferred too many times in a row. */
export const SUBSCRIPTION_WINDOW_WAIT_EXHAUSTED_ERROR_CODE = "subscription_window_wait_exhausted";

/** Wait used when the provider reports no reset time for a saturated window. */
export const SUBSCRIPTION_WINDOW_WAIT_DEFAULT_MS = readPositiveIntEnv(
  "PAPERCLIP_SUBSCRIPTION_WINDOW_WAIT_DEFAULT_MS",
  15 * 60 * 1000,
);
/**
 * Upper bound on consecutive deferrals of one run. A healthy window resets
 * within a week, so this only trips when the quota snapshot is stale or the
 * account is wedged; the run is then cancelled through the normal path so the
 * problem becomes visible instead of waiting forever.
 */
export const SUBSCRIPTION_WINDOW_WAIT_MAX_ATTEMPTS = readPositiveIntEnv(
  "PAPERCLIP_SUBSCRIPTION_WINDOW_WAIT_MAX_ATTEMPTS",
  48,
);
/** Small margin after the reported reset so the provider has rolled the window. */
const SUBSCRIPTION_WINDOW_RESET_MARGIN_MS = 30 * 1000;

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type SubscriptionWindowPolicy = {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  windowKind: SubscriptionBudgetWindowKind;
  /** Percent of the window that may be used before new runs are deferred. */
  amount: number;
};

export type SubscriptionWindowWait = {
  policyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  windowKind: SubscriptionBudgetWindowKind;
  quotaKey: string;
  provider: string;
  usedPercent: number;
  limitPercent: number;
  resetsAt: string | null;
  /** When the deferred run should be promoted again. */
  resumeAt: Date;
  reason: string;
};

export type SubscriptionWindowObservation = {
  usedPercent: number | null;
  resetsAt: string | null;
};

function parseResetsAt(value: string | null | undefined, now: Date): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getTime() > now.getTime() ? parsed : null;
}

export function findQuotaWindow(
  windows: QuotaWindow[],
  windowKind: SubscriptionBudgetWindowKind,
): QuotaWindow | null {
  const key = SUBSCRIPTION_BUDGET_WINDOW_QUOTA_KEYS[windowKind];
  return windows.find((window) => window.key === key) ?? null;
}

export function observeSubscriptionWindow(
  result: ProviderQuotaResult | null | undefined,
  windowKind: SubscriptionBudgetWindowKind,
): SubscriptionWindowObservation | null {
  if (!result || !result.ok) return null;
  const window = findQuotaWindow(result.windows, windowKind);
  if (!window) return null;
  return { usedPercent: window.usedPercent, resetsAt: window.resetsAt };
}

/**
 * Pure decision: given the active subscription policies for a dispatch and the
 * provider's current windows, return the wait to apply, or null to proceed.
 *
 * A window with no reported utilization never blocks. When several policies
 * block at once, the wait ends at the latest reset, because every blocking
 * window has to clear before a run can start.
 */
export function decideSubscriptionWindowWait(input: {
  policies: SubscriptionWindowPolicy[];
  windows: QuotaWindow[];
  provider: string;
  now?: Date;
  defaultWaitMs?: number;
}): SubscriptionWindowWait | null {
  const now = input.now ?? new Date();
  const defaultWaitMs = input.defaultWaitMs ?? SUBSCRIPTION_WINDOW_WAIT_DEFAULT_MS;
  let chosen: SubscriptionWindowWait | null = null;

  for (const policy of input.policies) {
    if (policy.amount <= 0) continue;
    const window = findQuotaWindow(input.windows, policy.windowKind);
    if (!window || window.usedPercent == null) continue;
    if (window.usedPercent < policy.amount) continue;

    const resetsAt = parseResetsAt(window.resetsAt, now);
    const resumeAt = resetsAt
      ? new Date(resetsAt.getTime() + SUBSCRIPTION_WINDOW_RESET_MARGIN_MS)
      : new Date(now.getTime() + defaultWaitMs);
    const windowLabel = policy.windowKind === "provider_session" ? "session" : "weekly";
    const candidate: SubscriptionWindowWait = {
      policyId: policy.id,
      scopeType: policy.scopeType,
      scopeId: policy.scopeId,
      windowKind: policy.windowKind,
      quotaKey: SUBSCRIPTION_BUDGET_WINDOW_QUOTA_KEYS[policy.windowKind],
      provider: input.provider,
      usedPercent: window.usedPercent,
      limitPercent: policy.amount,
      resetsAt: resetsAt ? resetsAt.toISOString() : null,
      resumeAt,
      reason:
        `${input.provider} ${windowLabel} subscription window is at ${window.usedPercent}% ` +
        `(limit ${policy.amount}% for ${policy.scopeType} scope); ` +
        (resetsAt ? `window resets at ${resetsAt.toISOString()}` : "no reset time reported"),
    };
    if (!chosen || candidate.resumeAt.getTime() > chosen.resumeAt.getTime()) {
      chosen = candidate;
    }
  }

  return chosen;
}

export type SubscriptionWindowGateInput = {
  companyId: string;
  agentId: string;
  adapterType: string;
  projectId?: string | null;
  now?: Date;
};

export function subscriptionWindowGateService(
  db: Db,
  deps: { readQuotaSnapshot?: QuotaSnapshotReader } = {},
) {
  const readQuotaSnapshot = deps.readQuotaSnapshot ?? readSharedQuotaSnapshot;

  async function listPolicies(input: {
    companyId: string;
    agentId: string;
    projectId?: string | null;
  }): Promise<SubscriptionWindowPolicy[]> {
    const scopeConditions = [
      and(eq(budgetPolicies.scopeType, "company"), eq(budgetPolicies.scopeId, input.companyId)),
      and(eq(budgetPolicies.scopeType, "agent"), eq(budgetPolicies.scopeId, input.agentId)),
    ];
    if (input.projectId) {
      scopeConditions.push(
        and(eq(budgetPolicies.scopeType, "project"), eq(budgetPolicies.scopeId, input.projectId)),
      );
    }
    const rows = await db
      .select({
        id: budgetPolicies.id,
        scopeType: budgetPolicies.scopeType,
        scopeId: budgetPolicies.scopeId,
        windowKind: budgetPolicies.windowKind,
        amount: budgetPolicies.amount,
      })
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, input.companyId),
          eq(budgetPolicies.isActive, true),
          eq(budgetPolicies.metric, "subscription_percent"),
          gt(budgetPolicies.amount, 0),
          inArray(budgetPolicies.scopeType, ["company", "agent", "project"]),
          or(...scopeConditions),
        ),
      );
    return rows.flatMap((row) =>
      isSubscriptionBudgetWindowKind(row.windowKind)
        ? [{
            id: row.id,
            scopeType: row.scopeType as BudgetScopeType,
            scopeId: row.scopeId,
            windowKind: row.windowKind,
            amount: row.amount,
          }]
        : [],
    );
  }

  return {
    listPolicies,

    /**
     * Returns the wait to apply before starting a run for this agent, or null.
     * Quota fetch failures fail open: an unreachable usage endpoint must not
     * stop work, and the provider's real limit still applies.
     */
    evaluate: async (input: SubscriptionWindowGateInput): Promise<SubscriptionWindowWait | null> => {
      const policies = await listPolicies(input);
      if (policies.length === 0) return null;
      const now = input.now ?? new Date();
      const provider = providerSlugForAdapterType(input.adapterType);
      const snapshot = await readQuotaSnapshot({ now });
      const result = snapshot.results.find((row) => row.provider === provider);
      if (!result || !result.ok) return null;
      return decideSubscriptionWindowWait({ policies, windows: result.windows, provider, now });
    },
  };
}
