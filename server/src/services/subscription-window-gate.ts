import { and, eq, gt, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { budgetPolicies } from "@paperclipai/db";
import {
  SUBSCRIPTION_BUDGET_WINDOW_DURATION_MS,
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
 *
 * A *progressive* policy releases its limit evenly over the window instead of
 * all at once (70% of a week releases 10% a day; 100% of a session releases
 * 20% an hour). Usage ahead of the released share is deferred to the moment
 * the release catches up, which is earlier than the reset while the full
 * limit is not yet used, so the sawtooth of "run, wait for release, run"
 * spreads the window's budget across its whole length.
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
 * Re-check interval while a limited window's usage cannot be read. A limit
 * that cannot be checked holds new runs instead of letting them through: the
 * operator asked for headroom, and dispatching blind is how a limit gets
 * busted. Removing the limit lets runs proceed at the operator's discretion.
 */
export const SUBSCRIPTION_WINDOW_UNKNOWN_WAIT_MS = readPositiveIntEnv(
  "PAPERCLIP_SUBSCRIPTION_WINDOW_UNKNOWN_WAIT_MS",
  5 * 60 * 1000,
);
/**
 * A stale read (the last good value, reused because the latest refresh was
 * throttled or failed) may still clear a run when it is young enough and
 * leaves enough headroom for usage to have drifted since. The drift allowance
 * is per minute of age; one percent a minute is the burn rate observed on a
 * busy session window. Older or tighter stale reads hold for a re-check.
 */
export const SUBSCRIPTION_WINDOW_STALE_READ_MAX_AGE_MS = readPositiveIntEnv(
  "PAPERCLIP_SUBSCRIPTION_WINDOW_STALE_READ_MAX_AGE_MS",
  3 * 60 * 1000,
);
export const SUBSCRIPTION_WINDOW_USAGE_DRIFT_PERCENT_PER_MINUTE = readPositiveNumberEnv(
  "PAPERCLIP_SUBSCRIPTION_WINDOW_USAGE_DRIFT_PERCENT_PER_MINUTE",
  1,
);
/**
 * Upper bound on how long one run may keep waiting, measured from its first
 * consecutive deferral by this gate. A weekly window can stay legitimately
 * saturated for seven days, and the Claude CLI fallback reports no reset time
 * at all (so a saturated window is re-checked every default wait), which is
 * why the bound is a duration rather than a count of deferrals. It only trips
 * when the quota snapshot is stale or the account is wedged; the run is then
 * cancelled the way the daily cap cancels a queued run, so the problem becomes
 * visible instead of waiting forever.
 */
export const SUBSCRIPTION_WINDOW_WAIT_MAX_MS = readPositiveIntEnv(
  "PAPERCLIP_SUBSCRIPTION_WINDOW_WAIT_MAX_MS",
  8 * 24 * 60 * 60 * 1000,
);
/** Small margin after the reported reset so the provider has rolled the window. */
const SUBSCRIPTION_WINDOW_RESET_MARGIN_MS = 30 * 1000;

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export type StaleReadVerdict =
  | { clears: true; ageMs: number; projectedPercent: number }
  | { clears: false; ageMs: number | null; projectedPercent: number | null; why: "no_read_time" | "too_old" | "no_headroom" };

/**
 * Pure check: may a stale below-limit read still clear a run? Only when the
 * read is young enough and, after allowing for usage drift since it was
 * taken, still sits under the limit.
 */
export function judgeStaleRead(input: {
  usedPercent: number;
  limitPercent: number;
  observedAt: string | null | undefined;
  now: Date;
  maxAgeMs?: number;
  driftPercentPerMinute?: number;
}): StaleReadVerdict {
  const maxAgeMs = input.maxAgeMs ?? SUBSCRIPTION_WINDOW_STALE_READ_MAX_AGE_MS;
  const drift = input.driftPercentPerMinute ?? SUBSCRIPTION_WINDOW_USAGE_DRIFT_PERCENT_PER_MINUTE;
  const observed = input.observedAt ? new Date(input.observedAt).getTime() : Number.NaN;
  if (Number.isNaN(observed)) return { clears: false, ageMs: null, projectedPercent: null, why: "no_read_time" };
  const ageMs = Math.max(0, input.now.getTime() - observed);
  const projectedPercent = input.usedPercent + drift * (ageMs / 60_000);
  if (ageMs > maxAgeMs) return { clears: false, ageMs, projectedPercent, why: "too_old" };
  if (projectedPercent >= input.limitPercent) return { clears: false, ageMs, projectedPercent, why: "no_headroom" };
  return { clears: true, ageMs, projectedPercent };
}

/**
 * Whether the gate would hold new runs for a policy given the observation the
 * summary shows: unreadable usage under a limit, or a stale read that is too
 * old or too close to the limit. Used to label the budget card honestly.
 */
export function isSubscriptionUsageHeld(input: {
  limitPercent: number;
  usedPercent: number | null;
  stale: boolean;
  observedAt: string | null | undefined;
  now?: Date;
}): boolean {
  if (input.limitPercent <= 0) return false;
  if (input.usedPercent == null) return true;
  if (input.usedPercent >= input.limitPercent) return false;
  if (!input.stale) return false;
  return !judgeStaleRead({
    usedPercent: input.usedPercent,
    limitPercent: input.limitPercent,
    observedAt: input.observedAt,
    now: input.now ?? new Date(),
  }).clears;
}

export type SubscriptionWindowPolicy = {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  windowKind: SubscriptionBudgetWindowKind;
  /** Percent of the window that may be used before new runs are deferred. */
  amount: number;
  /** Release `amount` evenly over the window: only the elapsed share is in force. */
  progressive: boolean;
};

export type SubscriptionWindowWait = {
  policyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  windowKind: SubscriptionBudgetWindowKind;
  quotaKey: string;
  provider: string;
  /** Percent used, or null when the run is held because usage could not be read. */
  usedPercent: number | null;
  /** The configured limit, released in full or progressively (see `progressive`). */
  limitPercent: number;
  progressive: boolean;
  /**
   * Percent of the window in force at decision time: `limitPercent` for a
   * fixed limit, the elapsed share for a progressive one; null when usage is
   * unknown and the hold is a re-check.
   */
  releasedPercent: number | null;
  /**
   * When a progressive limit has released enough for the usage, so the run
   * can be re-checked before the reset; null when the wait is for the reset
   * or a re-check of unknown usage.
   */
  releaseAt: string | null;
  /** True when the hold is for unreadable usage rather than a reached limit. */
  usageUnknown: boolean;
  resetsAt: string | null;
  /** When the deferred run should be promoted again. */
  resumeAt: Date;
  reason: string;
};

export type SubscriptionWindowObservation = {
  usedPercent: number | null;
  resetsAt: string | null;
  /** True when the latest provider read failed and this comes from the last successful read. */
  stale: boolean;
  /** ISO timestamp of the provider read behind this observation, null for a raw adapter result. */
  observedAt: string | null;
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

export type SubscriptionWindowRelease = {
  /** Percent of the window the policy allows right now. */
  releasedPercent: number;
  /** Share of the window elapsed (0-1), null when the reset time is unknown. */
  elapsedFraction: number | null;
  /** Window bounds derived from the reported reset, null when it is unknown. */
  windowStart: Date | null;
  windowEnd: Date | null;
};

/**
 * Pure: the part of a limit in force at `now`. A fixed limit is in force in
 * full. A progressive limit is released linearly over the provider window:
 * the released share is `limit × elapsed / duration`, with the window start
 * derived from the reported reset minus the nominal window length. Without a
 * usable reset time the window position is unknown, so the full limit
 * applies: the configured ceiling still holds and only the smoothing is lost,
 * which beats holding every run until a reset is reported.
 */
export function releaseSubscriptionLimit(input: {
  limitPercent: number;
  windowKind: SubscriptionBudgetWindowKind;
  progressive: boolean;
  resetsAt: string | null | undefined;
  now?: Date;
}): SubscriptionWindowRelease {
  const now = input.now ?? new Date();
  const resetsAt = parseResetsAt(input.resetsAt, now);
  if (!resetsAt) {
    return { releasedPercent: input.limitPercent, elapsedFraction: null, windowStart: null, windowEnd: null };
  }
  const durationMs = SUBSCRIPTION_BUDGET_WINDOW_DURATION_MS[input.windowKind];
  const windowStart = new Date(resetsAt.getTime() - durationMs);
  const elapsedFraction = Math.min(1, Math.max(0, (now.getTime() - windowStart.getTime()) / durationMs));
  return {
    releasedPercent: input.progressive ? input.limitPercent * elapsedFraction : input.limitPercent,
    elapsedFraction,
    windowStart,
    windowEnd: resetsAt,
  };
}

export type SubscriptionReleaseEvaluation = {
  release: SubscriptionWindowRelease;
  /** True when usage is at or ahead of the released share, so new runs wait. */
  held: boolean;
  /**
   * When a progressive limit catches up with the usage, set only while held
   * below the full limit; null when the full limit is reached (the wait is
   * then for the reset) or when nothing is held.
   */
  releaseAt: Date | null;
};

/**
 * Pure: compares known usage with the released share of a limit. Usage of 0
 * is never held, because nothing has been consumed to pace. Held below the
 * full limit, a progressive policy names the moment its linear release
 * reaches the usage (`windowStart + used / limit × duration`), which is the
 * earliest time the run can go again; at or above the full limit the reset
 * is the only way out, as for a fixed limit.
 */
export function evaluateSubscriptionRelease(input: {
  usedPercent: number;
  limitPercent: number;
  windowKind: SubscriptionBudgetWindowKind;
  progressive: boolean;
  resetsAt: string | null | undefined;
  now?: Date;
}): SubscriptionReleaseEvaluation {
  const release = releaseSubscriptionLimit(input);
  const held = input.limitPercent > 0 && input.usedPercent > 0 && input.usedPercent >= release.releasedPercent;
  if (!held || !input.progressive || input.usedPercent >= input.limitPercent || !release.windowStart) {
    return { release, held, releaseAt: null };
  }
  const durationMs = SUBSCRIPTION_BUDGET_WINDOW_DURATION_MS[input.windowKind];
  const share = Math.min(1, Math.max(0, input.usedPercent / input.limitPercent));
  return {
    release,
    held,
    releaseAt: new Date(release.windowStart.getTime() + share * durationMs),
  };
}

function formatPercent(value: number) {
  return String(Math.round(value * 10) / 10);
}

export function observeSubscriptionWindow(
  result: ProviderQuotaResult | null | undefined,
  windowKind: SubscriptionBudgetWindowKind,
): SubscriptionWindowObservation | null {
  if (!result || !result.ok) return null;
  const window = findQuotaWindow(result.windows, windowKind);
  if (!window) return null;
  return {
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    stale: result.stale === true,
    observedAt: result.observedAt ?? null,
  };
}

/**
 * Pure decision: given the active subscription policies for a dispatch and the
 * provider's quota result, return the wait to apply, or null to proceed.
 *
 * A policy whose window cannot be read (the provider row is missing or not ok,
 * the window is absent, or it carries no utilization) holds the run for
 * `unknownWaitMs` and re-checks; only a scope with no limit stays open. A
 * stale result (the last good read, reused because the latest refresh was
 * throttled or failed) at or above the limit defers to the reset as usual.
 * Below the limit it clears the run only while it is young and leaves enough
 * headroom for the drift since it was taken (see judgeStaleRead); otherwise
 * real usage may have crossed the limit, so the run holds for a re-check
 * instead. When several policies block at once, the wait ends at the latest
 * resume time, because every blocking window has to clear before a run can
 * start, so a known saturated window outranks an unknown one.
 *
 * A progressive policy is measured against its released share rather than the
 * full limit (see evaluateSubscriptionRelease): held below the full limit, the
 * run resumes just after the release catches up with the usage instead of at
 * the reset. The stale rule applies to the released share the same way.
 */
export function decideSubscriptionWindowWait(input: {
  policies: SubscriptionWindowPolicy[];
  /** The provider's row from the quota snapshot, or null when it has none. */
  result: ProviderQuotaResult | null | undefined;
  provider: string;
  now?: Date;
  defaultWaitMs?: number;
  unknownWaitMs?: number;
  staleReadMaxAgeMs?: number;
  usageDriftPercentPerMinute?: number;
}): SubscriptionWindowWait | null {
  const now = input.now ?? new Date();
  const defaultWaitMs = input.defaultWaitMs ?? SUBSCRIPTION_WINDOW_WAIT_DEFAULT_MS;
  const unknownWaitMs = input.unknownWaitMs ?? SUBSCRIPTION_WINDOW_UNKNOWN_WAIT_MS;
  const result = input.result ?? null;
  const windows = result?.ok ? result.windows : null;
  const stale = result?.stale === true;
  let chosen: SubscriptionWindowWait | null = null;

  for (const policy of input.policies) {
    if (policy.amount <= 0) continue;
    const windowLabel = policy.windowKind === "provider_session" ? "session" : "weekly";
    const base = {
      policyId: policy.id,
      scopeType: policy.scopeType,
      scopeId: policy.scopeId,
      windowKind: policy.windowKind,
      quotaKey: SUBSCRIPTION_BUDGET_WINDOW_QUOTA_KEYS[policy.windowKind],
      provider: input.provider,
      limitPercent: policy.amount,
      progressive: policy.progressive,
    };
    const window = windows ? findQuotaWindow(windows, policy.windowKind) : null;
    const usedPercent = window?.usedPercent ?? null;
    const evaluation =
      usedPercent == null
        ? null
        : evaluateSubscriptionRelease({
            usedPercent,
            limitPercent: policy.amount,
            windowKind: policy.windowKind,
            progressive: policy.progressive,
            resetsAt: window?.resetsAt,
            now,
          });
    // A stale read that the release would let through must still prove
    // headroom against the share in force now (see judgeStaleRead).
    const staleVerdict =
      stale && usedPercent != null && evaluation != null && !evaluation.held
        ? judgeStaleRead({
            usedPercent,
            limitPercent: evaluation.release.releasedPercent,
            observedAt: result?.observedAt,
            now,
            maxAgeMs: input.staleReadMaxAgeMs,
            driftPercentPerMinute: input.usageDriftPercentPerMinute,
          })
        : null;
    let candidate: SubscriptionWindowWait;
    if (usedPercent == null || evaluation == null || (staleVerdict && !staleVerdict.clears)) {
      const staleCause = () => {
        const failed = `the latest provider read ${result?.rateLimited ? "was throttled" : "failed"}${result?.error ? ` (${result.error})` : ""}`;
        const last = `the last good read of ${usedPercent}%${result?.observedAt ? ` at ${result.observedAt}` : ""}`;
        if (!staleVerdict || staleVerdict.clears) return `${failed}, and ${last} cannot clear the limit`;
        if (staleVerdict.why === "no_read_time") return `${failed}, and ${last} has no read time`;
        const ageMin = Math.round((staleVerdict.ageMs ?? 0) / 6_000) / 10;
        if (staleVerdict.why === "too_old") return `${failed}, and ${last} is ${ageMin} min old, older than the gate accepts`;
        return `${failed}, and ${last} is ${ageMin} min old, which with usage drift may already be at the limit`;
      };
      const cause =
        windows == null
          ? `provider usage could not be read${result?.error ? ` (${result.error})` : ""}`
          : !window
            ? "the provider did not report this window"
            : usedPercent == null
              ? "the provider reported this window without utilization"
              : staleCause();
      candidate = {
        ...base,
        usedPercent: null,
        releasedPercent: null,
        releaseAt: null,
        usageUnknown: true,
        resetsAt: null,
        resumeAt: new Date(now.getTime() + unknownWaitMs),
        reason:
          `${input.provider} ${windowLabel} subscription window usage is unknown (${cause}); ` +
          `new runs wait while the ${policy.amount}% limit for the ${policy.scopeType} scope cannot be checked`,
      };
    } else {
      if (!evaluation.held) continue;
      const resetsAt = parseResetsAt(window!.resetsAt, now);
      const releaseAt = evaluation.releaseAt;
      const releasedPercent = evaluation.release.releasedPercent;
      candidate = {
        ...base,
        usedPercent,
        releasedPercent,
        releaseAt: releaseAt ? releaseAt.toISOString() : null,
        usageUnknown: false,
        resetsAt: resetsAt ? resetsAt.toISOString() : null,
        resumeAt: releaseAt
          ? new Date(releaseAt.getTime() + SUBSCRIPTION_WINDOW_RESET_MARGIN_MS)
          : resetsAt
            ? new Date(resetsAt.getTime() + SUBSCRIPTION_WINDOW_RESET_MARGIN_MS)
            : new Date(now.getTime() + defaultWaitMs),
        reason: releaseAt
          ? `${input.provider} ${windowLabel} subscription window is at ${usedPercent}%, ahead of the ` +
            `${formatPercent(releasedPercent)}% released so far of the progressive ${policy.amount}% limit ` +
            `for ${policy.scopeType} scope; enough is released at ${releaseAt.toISOString()}`
          : `${input.provider} ${windowLabel} subscription window is at ${usedPercent}% ` +
            `(${policy.progressive ? "progressive " : ""}limit ${policy.amount}% for ${policy.scopeType} scope); ` +
            (resetsAt ? `window resets at ${resetsAt.toISOString()}` : "no reset time reported"),
      };
    }
    if (!chosen || candidate.resumeAt.getTime() > chosen.resumeAt.getTime()) {
      chosen = candidate;
    }
  }

  return chosen;
}

export type SubscriptionWindowWaitBound = {
  /** Latest moment the run may still be waiting before it is cancelled. */
  deadline: Date;
  /** True once `now` has reached the deadline. */
  exhausted: boolean;
  /**
   * The wait's resume time clamped to the deadline, so a bogus far-future
   * reset time cannot hold the run past the bound.
   */
  resumeAt: Date;
};

/**
 * Pure bound on one run's consecutive wait. `waitStartedAt` is the first
 * deferral by this gate in the current chain; retries for unrelated reasons
 * before it do not count.
 */
export function boundSubscriptionWindowWait(input: {
  waitStartedAt: Date;
  resumeAt: Date;
  now?: Date;
  maxWaitMs?: number;
}): SubscriptionWindowWaitBound {
  const now = input.now ?? new Date();
  const maxWaitMs = input.maxWaitMs ?? SUBSCRIPTION_WINDOW_WAIT_MAX_MS;
  const deadline = new Date(input.waitStartedAt.getTime() + maxWaitMs);
  return {
    deadline,
    exhausted: now.getTime() >= deadline.getTime(),
    resumeAt: input.resumeAt.getTime() > deadline.getTime() ? deadline : input.resumeAt,
  };
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
        progressive: budgetPolicies.progressive,
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
            progressive: row.progressive,
          }]
        : [],
    );
  }

  return {
    listPolicies,

    /**
     * Returns the wait to apply before starting a run for this agent, or null.
     * A scope with no active limit has nothing to check and proceeds. Under a
     * limit, usage that cannot be read holds the run for a short re-check
     * instead of letting it through (see decideSubscriptionWindowWait).
     */
    evaluate: async (input: SubscriptionWindowGateInput): Promise<SubscriptionWindowWait | null> => {
      const policies = await listPolicies(input);
      if (policies.length === 0) return null;
      const now = input.now ?? new Date();
      const provider = providerSlugForAdapterType(input.adapterType);
      const snapshot = await readQuotaSnapshot({ now });
      const result = snapshot.results.find((row) => row.provider === provider) ?? null;
      return decideSubscriptionWindowWait({ policies, result, provider, now });
    },
  };
}
