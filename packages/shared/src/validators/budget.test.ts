import { describe, expect, it } from "vitest";
import { upsertBudgetPolicySchema } from "./budget.js";

const scopeId = "3f6c1c4a-1d34-4b52-9b5f-2f3a5d1c9e10";

describe("upsertBudgetPolicySchema", () => {
  it("defaults to a monthly billed_cents policy", () => {
    const parsed = upsertBudgetPolicySchema.parse({ scopeType: "company", scopeId, amount: 5000 });
    expect(parsed.metric).toBe("billed_cents");
    expect(parsed.windowKind).toBe("calendar_month_utc");
  });

  it("accepts subscription_percent policies on provider windows", () => {
    for (const windowKind of ["provider_session", "provider_week"] as const) {
      const parsed = upsertBudgetPolicySchema.parse({
        scopeType: "agent",
        scopeId,
        metric: "subscription_percent",
        provider: "openai",
        windowKind,
        amount: 80,
      });
      expect(parsed.windowKind).toBe(windowKind);
    }
  });

  it("rejects subscription_percent policies on calendar windows and above 100 percent", () => {
    expect(
      upsertBudgetPolicySchema.safeParse({
        scopeType: "company",
        scopeId,
        metric: "subscription_percent",
        provider: "openai",
        windowKind: "calendar_month_utc",
        amount: 80,
      }).success,
    ).toBe(false);
    expect(
      upsertBudgetPolicySchema.safeParse({
        scopeType: "company",
        scopeId,
        metric: "subscription_percent",
        provider: "openai",
        windowKind: "provider_week",
        amount: 101,
      }).success,
    ).toBe(false);
  });

  it("accepts progressive release on subscription policies and leaves it unset when omitted", () => {
    const progressive = upsertBudgetPolicySchema.parse({
      scopeType: "company",
      scopeId,
      metric: "subscription_percent",
        provider: "openai",
      windowKind: "provider_week",
      amount: 100,
      pacePercent: 20,
      progressive: true,
    });
    expect(progressive.progressive).toBe(true);
    // Omitted means "keep what is stored", so the schema must not default it.
    const omitted = upsertBudgetPolicySchema.parse({
      scopeType: "company",
      scopeId,
      metric: "subscription_percent",
        provider: "openai",
      windowKind: "provider_week",
      amount: 70,
    });
    expect(omitted.progressive).toBeUndefined();
  });

  it("rejects progressive release on money budgets", () => {
    const result = upsertBudgetPolicySchema.safeParse({
      scopeType: "company",
      scopeId,
      amount: 5000,
      progressive: true,
    });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join("."))).toContain("progressive");
    // An explicit false is fine anywhere.
    expect(upsertBudgetPolicySchema.safeParse({ scopeType: "company", scopeId, amount: 5000, progressive: false }).success).toBe(true);
  });

  it("rejects billed_cents policies on provider windows", () => {
    expect(
      upsertBudgetPolicySchema.safeParse({
        scopeType: "company",
        scopeId,
        windowKind: "provider_session",
        amount: 5000,
      }).success,
    ).toBe(false);
  });
});

// A provider is a rule dimension, not a label inferred from the largest usage.
describe("provider budget rules", () => {
  const base = { scopeType: "company", scopeId, metric: "subscription_percent", windowKind: "provider_week", amount: 100 };
  it("requires an explicit supported subscription provider", () => {
    expect(upsertBudgetPolicySchema.safeParse(base).success).toBe(false);
    expect(upsertBudgetPolicySchema.safeParse({ ...base, provider: "other" }).success).toBe(false);
    for (const provider of ["openai", "anthropic"]) expect(upsertBudgetPolicySchema.safeParse({ ...base, provider }).success).toBe(true);
  });
  it("rejects provider selection on money budgets", () => {
    expect(upsertBudgetPolicySchema.safeParse({ scopeType: "company", scopeId, amount: 100, provider: "openai" }).success).toBe(false);
  });
});


describe("composable pace and cap validation", () => {
  const base = { scopeType: "company", scopeId, metric: "subscription_percent", provider: "openai", windowKind: "provider_week", amount: 100, progressive: true };
  it("accepts fractional and fast paces independently of the provider ceiling", () => {
    for (const pacePercent of [0.1, 20, 28, 140.5]) expect(upsertBudgetPolicySchema.safeParse({ ...base, pacePercent }).success).toBe(true);
  });
  it("requires a positive finite pace and keeps caps separate", () => {
    for (const pacePercent of [undefined, null, 0, -1, Infinity, NaN]) expect(upsertBudgetPolicySchema.safeParse({ ...base, pacePercent }).success).toBe(false);
    expect(upsertBudgetPolicySchema.safeParse({ ...base, pacePercent: 20, amount: 70 }).success).toBe(false);
    expect(upsertBudgetPolicySchema.safeParse({ ...base, pacePercent: 20, progressive: false }).success).toBe(false);
    expect(upsertBudgetPolicySchema.safeParse({ ...base, pacePercent: null, progressive: false, amount: 70 }).success).toBe(true);
  });
});
