import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  projects,
} from "@paperclipai/db";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { subscriptionWindowGateService } from "../services/subscription-window-gate.ts";
import { budgetService } from "../services/budgets.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

// Budget behavior is exercised against PostgreSQL below and in
// cost-accounting-reliability.test.ts, including transaction and retry paths.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budgetService release gate enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budgets-service-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    mockLogActivity.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createBudgetFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Budget Project",
      status: "in_progress",
    });

    return { companyId, agentId, projectId };
  }

  async function insertCostEvent(input: {
    companyId: string;
    agentId: string;
    projectId?: string | null;
    costCents: number;
    occurredAt?: Date;
  }) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        projectId: input.projectId ?? null,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5-release-gate",
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        costCents: input.costCents,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning();

    return event!;
  }

  it("raises one soft incident per window before hard-stopping and safely logging agent telemetry", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    const [policy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const softEvent = await insertCostEvent({ companyId, agentId, costCents: 80 });
    await service.evaluateCostEvent(softEvent);
    await service.evaluateCostEvent(softEvent);

    let incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows[0]).toMatchObject({
      companyId,
      policyId: policy!.id,
      scopeType: "agent",
      scopeId: agentId,
      thresholdType: "soft",
      amountLimit: 100,
      amountObserved: 80,
      approvalId: null,
      status: "open",
    });

    const [agentBeforeHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(agentBeforeHardStop).toEqual({ status: "active", pauseReason: null });

    const hardEvent = await insertCostEvent({ companyId, agentId, costCents: 25 });
    await service.evaluateCostEvent(hardEvent);
    await service.evaluateCostEvent(hardEvent);

    incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    expect(incidentRows.find((incident) => incident.thresholdType === "soft")).toMatchObject({
      status: "resolved",
    });
    expect(incidentRows.find((incident) => incident.thresholdType === "hard")).toMatchObject({
      amountLimit: 100,
      amountObserved: 105,
      status: "open",
    });

    const [approval] = await db.select().from(approvals);
    expect(approval).toMatchObject({
      companyId,
      type: "budget_override_required",
      status: "pending",
    });

    const [agentAfterHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason, pausedAt: agents.pausedAt })
      .from(agents);
    expect(agentAfterHardStop).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(agentAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(2);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "agent", scopeId: agentId, createdBefore: expect.any(Date), enforcement: { policyId: expect.any(String), version: expect.any(Number) } });

    const block = await service.getInvocationBlock(companyId, agentId);
    expect(block).toEqual({
      scopeType: "agent",
      scopeId: agentId,
      scopeName: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      reason: "Agent is paused because its budget hard-stop was reached.",
    });

    const telemetryCalls = mockLogActivity.mock.calls.map(([, input]) => input);
    expect(telemetryCalls.filter((call) => call.action === "budget.soft_threshold_crossed")).toHaveLength(1);
    expect(telemetryCalls.filter((call) => call.action === "budget.hard_threshold_crossed")).toHaveLength(1);
    expect(telemetryCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "budget.soft_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 80,
            amountLimit: 100,
          }),
        }),
        expect.objectContaining({
          action: "budget.hard_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 105,
            amountLimit: 100,
            approvalId: approval!.id,
          }),
        }),
      ]),
    );
    for (const call of telemetryCalls) {
      expect(JSON.stringify(call.details)).not.toContain("SECRET_TOKEN_SHOULD_NOT_LEAK");
      expect(call.details).not.toHaveProperty("prompt");
      expect(call.details).not.toHaveProperty("message");
    }
  });

  it("reports subscription usage as unavailable instead of a healthy 0% when the provider window is unknown", async () => {
    const { companyId } = await createBudgetFixture();
    let quota: ProviderQuotaResult[] = [
      { provider: "openai", ok: false, error: "usage endpoint down", windows: [] },
    ];
    const service = budgetService(db, {
      readQuotaSnapshot: async () => ({ results: quota, fetchedAt: new Date() }),
    });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "subscription_percent", provider: "openai",
      windowKind: "provider_session",
      amount: 80,
      warnPercent: 50,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const failedFetch = await service.overview(companyId);
    expect(failedFetch.policies[0]).toMatchObject({
      metric: "subscription_percent", provider: "openai",
      usageUnavailable: true,
      usageHeld: true,
      observedAmount: 0,
      status: "ok",
    });

    quota = [
      {
        provider: "openai",
        ok: true,
        windows: [
          { key: "seven_day", label: "Weekly limit", usedPercent: 40, resetsAt: null, valueLabel: null, detail: null },
        ],
      },
    ];
    const missingWindow = await service.overview(companyId);
    expect(missingWindow.policies[0]).toMatchObject({ usageUnavailable: true, observedAmount: 0, status: "ok" });

    quota = [
      {
        provider: "openai",
        ok: true,
        windows: [
          { key: "five_hour", label: "5h limit", usedPercent: null, resetsAt: null, valueLabel: null, detail: null },
        ],
      },
    ];
    const noUtilization = await service.overview(companyId);
    expect(noUtilization.policies[0]).toMatchObject({ usageUnavailable: true, observedAmount: 0, status: "ok" });

    quota = [
      {
        provider: "openai",
        ok: true,
        windows: [
          {
            key: "five_hour",
            label: "5h limit",
            usedPercent: 90,
            resetsAt: "2099-01-01T00:00:00.000Z",
            valueLabel: null,
            detail: null,
          },
        ],
      },
    ];
    const reported = await service.overview(companyId);
    expect(reported.policies[0]).toMatchObject({
      usageUnavailable: false,
      observedAmount: 90,
      remainingAmount: 0,
      status: "hard_stop",
    });
    expect(reported.policies[0]?.windowEnd.toISOString()).toBe("2099-01-01T00:00:00.000Z");
    expect(reported.policies[0]).toMatchObject({ usageStale: false, usageHeld: false, usageObservedAt: null });

    // A failed refresh keeps the last good read: still a measurement, flagged
    // as stale with its read time, never a flip back to "unavailable".
    quota = [
      {
        provider: "openai",
        ok: true,
        stale: true,
        observedAt: "2026-09-13T11:58:00.000Z",
        error: "usage endpoint down",
        windows: [
          { key: "five_hour", label: "5h limit", usedPercent: 60, resetsAt: null, valueLabel: null, detail: null },
        ],
      },
    ];
    const stale = await service.overview(companyId);
    expect(stale.policies[0]).toMatchObject({
      usageUnavailable: false,
      usageStale: true,
      // That read is far older than the gate accepts, so runs are held.
      usageHeld: true,
      usageObservedAt: "2026-09-13T11:58:00.000Z",
      observedAmount: 60,
      status: "warning",
    });

    // With the strict default a stale read from a minute ago still holds, and
    // the summary says so; the card mirrors whatever the gate decides.
    const recent = new Date(Date.now() - 60_000).toISOString();
    quota = [
      {
        provider: "openai",
        ok: true,
        stale: true,
        rateLimited: true,
        observedAt: recent,
        error: "usage api returned 429",
        windows: [
          { key: "five_hour", label: "5h limit", usedPercent: 40, resetsAt: null, valueLabel: null, detail: null },
        ],
      },
    ];
    const youngStale = await service.overview(companyId);
    expect(youngStale.policies[0]).toMatchObject({ usageStale: true, usageHeld: true, usageObservedAt: recent, observedAmount: 40 });
  });

  it("summarizes a progressive subscription limit against its released share and names the next release", async () => {
    const { companyId } = await createBudgetFixture();
    // A session window resetting in two hours started three hours ago: 60% of
    // the window, and so 60% of a progressive limit, has been released.
    const resetsAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const sessionWindow = (usedPercent: number): ProviderQuotaResult[] => [
      {
        provider: "openai",
        ok: true,
        windows: [
          { key: "five_hour", label: "5h limit", usedPercent, resetsAt: resetsAt.toISOString(), valueLabel: null, detail: null },
        ],
      },
    ];
    let quota = sessionWindow(40);
    const service = budgetService(db, {
      readQuotaSnapshot: async () => ({ results: quota, fetchedAt: new Date() }),
    });
    let policyId: string | undefined;
    const upsert = async (input: { amount: number; progressive?: boolean; pacePercent?: number | null }) => {
      const result = await service.upsertPolicy(
        companyId,
        { scopeType: "company", scopeId: companyId, metric: "subscription_percent", provider: "openai", windowKind: "provider_session", ...input },
        "user-1",
        policyId,
      );
      policyId = result.policyId;
      return result;
    };

    const created = await upsert({ amount: 100, progressive: true, pacePercent: 20 });
    expect(created).toMatchObject({ progressive: true, amount: 100, observedAmount: 40, releaseAt: null, releaseWindowUnknown: false, status: "ok" });
    expect(created.releasedAmount).toBeCloseTo(60, 0);
    expect(created.remainingAmount).toBeCloseTo(20, 0);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "budget.policy_upserted", details: expect.objectContaining({ progressive: true }) }),
      expect.anything(),
    );

    // Usage ahead of the release is held until the linear release reaches it:
    // 75% of a 5h window is 1h15m before the reset. The full limit is not
    // reached, so the status stays ok; the card reads the hold from releaseAt.
    quota = sessionWindow(75);
    const ahead = (await service.overview(companyId)).policies[0]!;
    expect(ahead).toMatchObject({ progressive: true, observedAmount: 75, remainingAmount: 0, status: "ok" });
    expect(ahead.releaseAt).toBeTruthy();
    expect(Math.abs(new Date(ahead.releaseAt!).getTime() - (resetsAt.getTime() - 75 * 60 * 1000))).toBeLessThan(1_000);

    // An amount-only update keeps the release mode; an explicit false clears it.
    expect(await upsert({ amount: 100 })).toMatchObject({ progressive: true, amount: 100, pacePercent: 20 });
    const cleared = await upsert({ amount: 90, progressive: false });
    expect(cleared).toMatchObject({ progressive: false, releasedAmount: 90, remainingAmount: 15, releaseAt: null });

    // Without a reset time the window position is unknown: the full limit is
    // in force and the summary says so rather than claiming "fully released".
    quota = [
      {
        provider: "openai",
        ok: true,
        windows: [{ key: "five_hour", label: "5h limit", usedPercent: 40, resetsAt: null, valueLabel: null, detail: null }],
      },
    ];
    const unknownReset = await upsert({ amount: 100, progressive: true, pacePercent: 18 });
    expect(unknownReset).toMatchObject({ progressive: true, releasedAmount: 100, releaseAt: null, releaseWindowUnknown: true });

    // Money budgets never release progressively, whatever the input says.
    const money = await service.upsertPolicy(
      companyId,
      { scopeType: "company", scopeId: companyId, amount: 5000, progressive: true },
      "user-1",
    );
    expect(money).toMatchObject({ metric: "billed_cents", progressive: false, releasedAmount: 5000 });
  });

  it("creates, edits and deletes independent provider rules with matching summaries and dispatch", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const now = new Date();
    const quota: ProviderQuotaResult[] = [
      { provider: "anthropic", ok: true, windows: [{ key: "seven_day", label: "Week", usedPercent: 17, resetsAt: new Date(now.getTime() + 6 * 3600000).toISOString(), valueLabel: null, detail: null }] },
      { provider: "openai", ok: true, windows: [{ key: "seven_day", label: "Week", usedPercent: 4, resetsAt: new Date(now.getTime() + 7 * 86400000 - 20 * 60000).toISOString(), valueLabel: null, detail: null }] },
    ];
    const readQuotaSnapshot = async () => ({ results: quota, fetchedAt: now });
    const service = budgetService(db, { readQuotaSnapshot });
    const gate = subscriptionWindowGateService(db, { readQuotaSnapshot });
    const input = { scopeType: "company" as const, scopeId: companyId, metric: "subscription_percent" as const, windowKind: "provider_week" as const, amount: 100, progressive: true, pacePercent: 100 / 7 };
    const openai = await service.upsertPolicy(companyId, { ...input, provider: "openai" }, "board");
    const anthropic = await service.upsertPolicy(companyId, { ...input, provider: "anthropic" }, "board");
    expect(openai.provider).toBe("openai");
    expect(openai.releasedAmount).toBeLessThan(1);
    expect(openai.observedAmount).toBe(4);
    expect(anthropic.releasedAmount).toBeGreaterThan(96);
    expect(anthropic.observedAmount).toBe(17);
    const dispatch = { companyId, agentId, now, adapterType: "codex_local" };
    expect(await gate.evaluate(dispatch)).toMatchObject({ provider: "openai", policyId: openai.policyId });
    expect(await gate.evaluate({ ...dispatch, adapterType: "claude_local" })).toBeNull();
    await expect(service.upsertPolicy(companyId, { ...input, provider: "openai" }, "board")).rejects.toMatchObject({ status: 409 });
    await expect(service.upsertPolicy(companyId, { ...input, provider: "anthropic" }, "board", openai.policyId)).rejects.toMatchObject({ status: 409 });
    const changed = await service.upsertPolicy(companyId, { ...input, provider: "openai", progressive: false, pacePercent: null, amount: 75 }, "board", openai.policyId);
    expect(changed).toMatchObject({ policyId: openai.policyId, provider: "openai", amount: 75, releasedAmount: 75, releaseAt: null });
    expect(await gate.evaluate(dispatch)).toBeNull();
    expect((await service.overview(companyId)).policies.find((p) => p.provider === "anthropic")?.amount).toBe(100);
    const other = await createBudgetFixture();
    await expect(service.deletePolicy(other.companyId, openai.policyId, "board")).rejects.toMatchObject({ status: 404 });
    await service.deletePolicy(companyId, openai.policyId, "board");
    expect((await service.overview(companyId)).policies.map((p) => p.provider)).toEqual(["anthropic"]);
    expect(await gate.evaluate(dispatch)).toBeNull();
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "budget.policy_deleted", entityId: openai.policyId }), expect.anything());
    const moved = await service.upsertPolicy(companyId, { ...input, provider: "openai", windowKind: "provider_session" }, "board", anthropic.policyId);
    expect(moved).toMatchObject({ provider: "openai", windowKind: "provider_session", usageUnavailable: true, usageHeld: true });
    expect(await gate.evaluate(dispatch)).toMatchObject({ provider: "openai", usageUnknown: true });
  });

  it("persists pace and cap together and applies both to summaries and dispatch", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const now = new Date();
    const resetsAt = new Date(now.getTime() + 3 * 86400000).toISOString();
    const serviceOptions = { readQuotaSnapshot: async () => ({ fetchedAt: now, results: [
      { provider: "openai", ok: true, windows: [{ key: "seven_day", label: "Week", usedPercent: 70, resetsAt, valueLabel: null, detail: null }] },
    ] as ProviderQuotaResult[] }) };
    const service = budgetService(db, serviceOptions);
    const gate = subscriptionWindowGateService(db, serviceOptions);
    const input = { scopeType: "company" as const, scopeId: companyId, metric: "subscription_percent" as const, provider: "openai", windowKind: "provider_week" as const };
    const pace = await service.upsertPolicy(companyId, { ...input, amount: 100, progressive: true, pacePercent: 20 }, "board");
    const cap = await service.upsertPolicy(companyId, { ...input, amount: 70, progressive: false }, "board");
    expect(pace).toMatchObject({ pacePercent: 20, amount: 100, releaseAt: null });
    expect(pace.releasedAmount).toBeCloseTo(80, 2);
    expect(cap).toMatchObject({ pacePercent: null, amount: 70, releasedAmount: 70 });
    expect((await service.overview(companyId)).policies).toHaveLength(2);
    const dispatch = { companyId, agentId, now, adapterType: "codex_local" };
    expect(await gate.evaluate(dispatch)).toMatchObject({ policyId: cap.policyId, releaseAt: null, resetsAt });
    await expect(service.upsertPolicy(companyId, { ...input, amount: 80, progressive: false }, "board")).rejects.toMatchObject({ status: 409 });
    await expect(service.upsertPolicy(companyId, { ...input, amount: 80, progressive: false }, "board", pace.policyId)).rejects.toMatchObject({ status: 409 });
    await service.deletePolicy(companyId, cap.policyId, "board");
    expect(await gate.evaluate(dispatch)).toBeNull();
    expect((await service.overview(companyId)).policies).toHaveLength(1);
  });

  it("distinguishes a company budget pause from a manual company pause", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const service = budgetService(db);
    await db.update(companies).set({ status: "paused", pauseReason: "budget" }).where(eq(companies.id, companyId));
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({
      scopeType: "company",
      scopeId: companyId,
      reason: "Budget pause requires a policy or an explicit operator resume.",
    });
    await db.update(companies).set({ pauseReason: null }).where(eq(companies.id, companyId));
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({
      scopeType: "company",
      scopeId: companyId,
      reason: "Company is paused and cannot start new work.",
    });
  });

  it("hard-stops project work until a valid budget raise resumes it and overview reconciles ledger spend", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 100,
      warnPercent: 75,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const event = await insertCostEvent({ companyId, agentId, projectId, costCents: 125 });
    await service.evaluateCostEvent(event);
    await service.evaluateCostEvent(event);

    const incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    const hardIncident = incidentRows.find((incident) => incident.thresholdType === "hard")!;
    expect(hardIncident).toMatchObject({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      amountLimit: 100,
      amountObserved: 125,
      status: "open",
    });

    const [projectAfterHardStop] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterHardStop?.pauseReason).toBe("budget");
    expect(projectAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "project", scopeId: projectId, createdBefore: expect.any(Date), enforcement: { policyId: expect.any(String), version: expect.any(Number) } });

    const overviewWhileBlocked = await service.overview(companyId);
    expect(overviewWhileBlocked.pausedProjectCount).toBe(1);
    expect(overviewWhileBlocked.pendingApprovalCount).toBe(1);
    expect(overviewWhileBlocked.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 100,
      observedAmount: 125,
      remainingAmount: 0,
      utilizationPercent: 125,
      status: "hard_stop",
      paused: true,
      pauseReason: "budget",
    });
    expect(overviewWhileBlocked.activeIncidents).toHaveLength(1);

    await expect(
      service.resolveIncident(
        companyId,
        hardIncident.id,
        { action: "raise_budget_and_resume", amount: 125 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");

    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toEqual({
      scopeType: "project",
      scopeId: projectId,
      scopeName: "Budget Project",
      reason: "Project cannot start work because its budget hard-stop is still exceeded.",
    });

    const resolved = await service.resolveIncident(
      companyId,
      hardIncident.id,
      { action: "raise_budget_and_resume", amount: 175, decisionNote: "Approved release-gate budget raise." },
      "board-user",
    );
    expect(resolved).toMatchObject({ status: "resolved", approvalStatus: "approved" });

    const [projectAfterResume] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterResume).toEqual({ pauseReason: null, pausedAt: null });
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();

    const overviewAfterResume = await service.overview(companyId);
    expect(overviewAfterResume.pausedProjectCount).toBe(0);
    expect(overviewAfterResume.pendingApprovalCount).toBe(0);
    expect(overviewAfterResume.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 175,
      observedAmount: 125,
      remainingAmount: 50,
      utilizationPercent: expect.closeTo(71.43, 2),
      status: "ok",
      paused: false,
      pauseReason: null,
    });
    expect(overviewAfterResume.activeIncidents).toHaveLength(0);
  });
});
