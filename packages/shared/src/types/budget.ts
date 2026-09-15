import type {
  BudgetIncidentResolutionAction,
  BudgetIncidentStatus,
  BudgetMetric,
  BudgetScopeType,
  BudgetThresholdType,
  BudgetWindowKind,
  PauseReason,
} from "../constants.js";

export interface BudgetPolicy {
  id: string;
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  amount: number;
  /**
   * Release `amount` evenly over the provider window instead of all at once
   * (`subscription_percent` policies only; always false for money budgets).
   */
  progressive: boolean;
  warnPercent: number;
  hardStopEnabled: boolean;
  notifyEnabled: boolean;
  isActive: boolean;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetPolicySummary {
  policyId: string;
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  amount: number;
  /**
   * True when the limit is released evenly over the provider window instead
   * of being available in full from the window start (`subscription_percent`
   * policies only).
   */
  progressive?: boolean;
  /**
   * The part of `amount` in force right now: `amount` itself for a fixed
   * limit, or the elapsed share of the window for a progressive one (the full
   * `amount` again when the provider reports no reset time, since the window
   * position is then unknown). `remainingAmount` is measured against it.
   */
  releasedAmount?: number;
  /**
   * ISO timestamp when a progressive limit next catches up with the observed
   * usage. Set only while usage is at or ahead of the released share, which
   * is when the gate holds new runs; null otherwise.
   */
  releaseAt?: string | null;
  /**
   * True for a progressive policy when the provider reported no usable reset
   * time, so the window position is unknown and the full `amount` is in force
   * until a reset is reported (`releasedAmount` then equals `amount`).
   */
  releaseWindowUnknown?: boolean;
  observedAmount: number;
  remainingAmount: number;
  utilizationPercent: number;
  /**
   * True for a `subscription_percent` policy whose provider window could not
   * be observed (quota fetch failed, window missing, or no utilization
   * reported). `observedAmount` is then 0 as a placeholder, not a measurement,
   * and `status` is "ok" only because nothing is known.
   */
  usageUnavailable?: boolean;
  /**
   * True for a `subscription_percent` policy whose `observedAmount` comes from
   * the last successful provider read because the latest read failed. The
   * value is a real measurement, just older than usual; `usageObservedAt`
   * says how old.
   */
  usageStale?: boolean;
  /** ISO timestamp of the provider read behind `observedAmount` (subscription policies only). */
  usageObservedAt?: string | null;
  warnPercent: number;
  hardStopEnabled: boolean;
  notifyEnabled: boolean;
  isActive: boolean;
  status: "ok" | "warning" | "hard_stop";
  paused: boolean;
  pauseReason: PauseReason | null;
  windowStart: Date;
  windowEnd: Date;
}

export interface BudgetIncident {
  id: string;
  companyId: string;
  policyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  windowStart: Date;
  windowEnd: Date;
  thresholdType: BudgetThresholdType;
  amountLimit: number;
  amountObserved: number;
  status: BudgetIncidentStatus;
  approvalId: string | null;
  approvalStatus: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetOverview {
  companyId: string;
  policies: BudgetPolicySummary[];
  activeIncidents: BudgetIncident[];
  pausedAgentCount: number;
  pausedProjectCount: number;
  pendingApprovalCount: number;
}

export interface BudgetPolicyUpsertInput {
  scopeType: BudgetScopeType;
  scopeId: string;
  metric?: BudgetMetric;
  windowKind?: BudgetWindowKind;
  amount: number;
  /** Omit to keep the stored value on an existing policy. */
  progressive?: boolean;
  warnPercent?: number;
  hardStopEnabled?: boolean;
  notifyEnabled?: boolean;
  isActive?: boolean;
}

export interface BudgetIncidentResolutionInput {
  action: BudgetIncidentResolutionAction;
  amount?: number;
  decisionNote?: string | null;
}
