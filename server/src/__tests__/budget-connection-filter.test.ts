import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetIncidents, budgetPolicies, companies, createDb, heartbeatRuns, projects, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { budgetService, computeObservedSpend } from "../services/budgets.js";
import { costService } from "../services/costs.js";
import { resolveRunConnection, subscriptionWindowGateService } from "../services/subscription-window-gate.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("connection budgets", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("budget-connection-filter-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { await database?.cleanup(); });

  /**
   * Architect: Claude Code on an Anthropic subscription connection.
   * Engineer: Claude Code on a MiniMax subscription connection (Anthropic-compatible gateway).
   * Reviewer: Claude Code on local credentials. Coder: Codex on local credentials.
   */
  async function fixture() {
    const companyId = randomUUID(), applicationId = randomUUID();
    const architectId = randomUUID(), engineerId = randomUUID(), reviewerId = randomUUID(), coderId = randomUUID();
    const claudeId = randomUUID(), minimaxId = randomUUID(), claudeGrant = randomUUID(), minimaxGrant = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Connections", issuePrefix: `C${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: applicationId, type: "rest_api" });
    await db.insert(toolConnections).values([
      { id: claudeId, companyId, applicationId, name: "My Claude subscription", uid: claudeId, connectionPurpose: "ai", transport: "runtime_auth",
        status: "active", enabled: true, config: { ai: { provider: "anthropic", method: "subscription" } } },
      { id: minimaxId, companyId, applicationId, name: "my api.minimax.io", uid: minimaxId, connectionPurpose: "ai", transport: "runtime_auth",
        status: "active", enabled: true, config: { ai: { provider: "anthropic", method: "subscription",
          routing: { kind: "gateway", protocol: "messages", baseUrl: "https://api.minimax.io/anthropic", auth: "bearer", models: [] } } } },
    ]);
    const shared = (connectionId: string, grantId: string) => ({ aiConnection: { provider: "anthropic", method: "subscription", mode: "shared", connectionId, grantId } });
    await db.insert(agents).values([
      { id: architectId, companyId, name: "Architect", role: "engineer", status: "idle", adapterType: "claude_local", runtimeConfig: shared(claudeId, claudeGrant) },
      { id: engineerId, companyId, name: "Engineer", role: "engineer", status: "idle", adapterType: "claude_local", runtimeConfig: shared(minimaxId, minimaxGrant) },
      { id: reviewerId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "claude_local" },
      { id: coderId, companyId, name: "Coder", role: "engineer", status: "idle", adapterType: "codex_local" },
    ]);
    const run = async (agentId: string, connectionId: string | null, extra: Partial<typeof heartbeatRuns.$inferInsert> = {}) => {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({ id, companyId, agentId, invocationSource: "on_demand", status: "succeeded",
        contextSnapshot: connectionId ? { aiConnection: { connectionId, provider: "anthropic", method: "subscription", mode: "shared", responsibleUserId: null } } : {}, ...extra });
      return id;
    };
    const charge = async (agentId: string, heartbeatRunId: string, costCents: string, provider = "anthropic") =>
      costService(db).createEvent(companyId, { agentId, heartbeatRunId, provider, biller: provider, billingType: "metered_api",
        costStatus: "reported", model: "test-model", inputTokens: 10, outputTokens: 5, costCents, occurredAt: new Date() });
    const agent = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0];
    return { companyId, architectId, engineerId, reviewerId, coderId, claudeId, minimaxId, minimaxGrant, run, charge, agent };
  }

  it("reports spend per connection, with Claude Code and Codex local credentials separate", async () => {
    const f = await fixture();
    expect((await f.charge(f.engineerId, await f.run(f.engineerId, f.minimaxId), "120")).aiConnectionId).toBe(f.minimaxId);
    await f.charge(f.architectId, await f.run(f.architectId, f.claudeId), "400");
    await f.charge(f.reviewerId, await f.run(f.reviewerId, null), "300");
    await f.charge(f.coderId, await f.run(f.coderId, null), "50", "openai");

    const rows = await costService(db).byConnection(f.companyId);
    expect(rows.map((row) => [row.connectionKey, row.connectionName, row.costCentsExact])).toEqual([
      [f.claudeId, "My Claude subscription", "400.0000000"],
      ["local:anthropic", "Claude Code local credentials", "300.0000000"],
      [f.minimaxId, "my api.minimax.io", "120.0000000"],
      ["local:openai", "Codex local credentials", "50.0000000"],
    ]);
    // Paperclip can read MiniMax plan usage through its gateway probe.
    expect(rows.find((row) => row.connectionKey === f.minimaxId)).toMatchObject({ method: "subscription", usageSupported: true });
  });

  it("resolves the account each agent's run will use", async () => {
    const f = await fixture();
    const resolve = async (id: string) => {
      const agent = await f.agent(id);
      return resolveRunConnection(db, { companyId: f.companyId, adapterType: agent.adapterType, aiConnection: agent.runtimeConfig.aiConnection });
    };
    expect(await resolve(f.engineerId)).toEqual({ key: f.minimaxId, grantId: f.minimaxGrant, provider: "anthropic" });
    expect((await resolve(f.architectId))?.key).toBe(f.claudeId);
    expect(await resolve(f.reviewerId)).toEqual({ key: "local:anthropic", grantId: null, provider: "anthropic" });
    expect(await resolve(f.coderId)).toEqual({ key: "local:openai", grantId: null, provider: "openai" });
  });

  it("holds only the connection that reached its budget; its scope and other connections keep running", async () => {
    const f = await fixture();
    const budgets = budgetService(db);
    await db.update(companies).set({ budgetMonthlyCents: 5000 }).where(eq(companies.id, f.companyId));
    const rule = await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, connectionFilter: f.minimaxId, amount: 100 }, "board");
    expect(rule).toMatchObject({ connectionFilter: f.minimaxId, connectionName: "my api.minimax.io", observedAmountExact: "0.0000000" });
    await f.charge(f.architectId, await f.run(f.architectId, f.claudeId), "500");
    expect(await budgets.getConnectionBlock(f.companyId, f.engineerId, null, f.minimaxId)).toBeNull();

    await f.charge(f.engineerId, await f.run(f.engineerId, f.minimaxId), "150");
    const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
    expect(company).toMatchObject({ status: "active", pauseReason: null, budgetMonthlyCents: 5000 });
    expect((await f.agent(f.engineerId)).lifecycleHolds).not.toContain("budget");
    expect(await budgets.getInvocationBlock(f.companyId, f.engineerId)).toBeNull();
    const block = await budgets.getConnectionBlock(f.companyId, f.engineerId, null, f.minimaxId);
    expect(block).toMatchObject({ policyId: rule.policyId, connectionName: "my api.minimax.io" });
    expect(block?.reason).toContain("spent 1.50 USD of its 1.00 USD budget");
    expect(await budgets.getConnectionBlock(f.companyId, f.architectId, null, f.claudeId)).toBeNull();

    const overview = await budgets.overview(f.companyId);
    expect(overview.policies.find((policy) => policy.policyId === rule.policyId)).toMatchObject({ status: "hard_stop", paused: false });
    expect(overview.activeIncidents[0]).toMatchObject({ policyId: rule.policyId, connectionName: "my api.minimax.io" });

    // Raising the budget frees the connection without touching the scope's own budget.
    await budgets.resolveIncident(f.companyId, overview.activeIncidents[0].id, { action: "raise_budget_and_resume", amount: 1000 }, "board");
    expect(await budgets.getConnectionBlock(f.companyId, f.engineerId, null, f.minimaxId)).toBeNull();
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].budgetMonthlyCents).toBe(5000);
  });

  it("keeps an edit by ID on its connection, and retires a fired rule on delete", async () => {
    const f = await fixture();
    const budgets = budgetService(db);
    const rule = await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, connectionFilter: "local:anthropic", amount: 100 }, "board");
    const edited = await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, amount: 200 }, "board", rule.policyId);
    expect(edited).toMatchObject({ policyId: rule.policyId, connectionFilter: "local:anthropic", connectionName: "Claude Code local credentials", amount: 200 });
    await f.charge(f.reviewerId, await f.run(f.reviewerId, null), "250");
    expect(await budgets.getConnectionBlock(f.companyId, f.reviewerId, null, "local:anthropic")).not.toBeNull();
    // Codex local credentials are a different account.
    expect(await budgets.getConnectionBlock(f.companyId, f.coderId, null, "local:openai")).toBeNull();

    await budgets.deletePolicy(f.companyId, rule.policyId, "board");
    const [retired] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, rule.policyId));
    expect(retired).toMatchObject({ amount: 0, isActive: false });
    expect((await db.select().from(budgetIncidents))[0].status).toBe("resolved");
    expect((await budgets.overview(f.companyId)).policies).toHaveLength(0);
    expect(await budgets.getConnectionBlock(f.companyId, f.reviewerId, null, "local:anthropic")).toBeNull();
  });

  it("holds runs on a subscription connection by that connection's own usage", async () => {
    const f = await fixture();
    const budgets = budgetService(db);
    await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, metric: "subscription_percent", windowKind: "provider_session",
      connectionFilter: f.minimaxId, amount: 50, progressive: false }, "board");
    const usage: Record<string, ProviderQuotaResult> = {
      [f.minimaxId]: { provider: "anthropic", ok: true, observedAt: new Date().toISOString(), windows: [
        { key: "five_hour", label: "5-hour usage", usedPercent: 80, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), valueLabel: null }] },
      [f.claudeId]: { provider: "anthropic", ok: true, observedAt: new Date().toISOString(), windows: [
        { key: "five_hour", label: "5h", usedPercent: 95, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), valueLabel: null }] },
    };
    const gate = subscriptionWindowGateService(db, { readConnectionUsage: async (_companyId, key) => usage[key] ?? null });
    const evaluate = async (agentId: string) => {
      const agent = await f.agent(agentId);
      return gate.evaluate({ companyId: f.companyId, agentId, adapterType: agent.adapterType, aiConnection: agent.runtimeConfig.aiConnection });
    };
    expect(await evaluate(f.engineerId)).toMatchObject({ usedPercent: 80, limitPercent: 50 });
    // The Anthropic subscription is nearly exhausted, but it has no rule and is another account.
    expect(await evaluate(f.architectId)).toBeNull();
    expect(await evaluate(f.reviewerId)).toBeNull();
  });

  it("maps a provider-only subscription rule to that provider's local credentials", async () => {
    const f = await fixture();
    const rule = await budgetService(db).upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, metric: "subscription_percent",
      provider: "openai", windowKind: "provider_week", amount: 70, progressive: false }, "board");
    expect(rule).toMatchObject({ connectionFilter: "local:openai", connectionName: "Codex local credentials", provider: "openai" });
  });

  it("rejects a connection from another company", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(budgetService(db).upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, connectionFilter: other.minimaxId, amount: 100 }, "board"))
      .rejects.toThrow(/AI connection in this company/);
  });

  it("matches unfinished runs on the connection recorded on the run, and local runs by harness", async () => {
    const f = await fixture();
    const [policy] = await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 1000, connectionFilter: f.minimaxId, notifyEnabled: false }).returning();
    const live = (agentId: string, connectionId: string | null, costUsd: number) => f.run(agentId, connectionId, { status: "running", costAccountingPending: true, usageJson: { costUsd } });
    await live(f.engineerId, f.minimaxId, 0.4);
    await live(f.reviewerId, null, 2);
    await live(f.coderId, null, 1);
    expect((await computeObservedSpend(db, policy)).liveObservedCents).toBe("40.0000000");
    expect((await computeObservedSpend(db, { ...policy, connectionFilter: "local:anthropic" })).liveObservedCents).toBe("200.0000000");
    expect((await computeObservedSpend(db, { ...policy, connectionFilter: "local:openai" })).liveObservedCents).toBe("100.0000000");
    expect((await computeObservedSpend(db, { ...policy, connectionFilter: "" })).liveObservedCents).toBe("340.0000000");
  });
  it("turns a rule off and back on without losing it", async () => {
    const f = await fixture();
    const budgets = budgetService(db);
    const rule = await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, connectionFilter: f.minimaxId, amount: 100 }, "board");
    expect(rule).toMatchObject({ isActive: true, amount: 100, configuredAmount: 100 });
    await f.charge(f.engineerId, await f.run(f.engineerId, f.minimaxId), "150");
    expect(await budgets.getConnectionBlock(f.companyId, f.engineerId, null, f.minimaxId)).not.toBeNull();

    const off = await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, connectionFilter: f.minimaxId, isActive: false }, "board", rule.policyId);
    expect(off).toMatchObject({ policyId: rule.policyId, isActive: false, amount: 0, configuredAmount: 100, status: "ok" });
    expect(await budgets.getConnectionBlock(f.companyId, f.engineerId, null, f.minimaxId)).toBeNull();
    expect((await budgets.overview(f.companyId)).activeIncidents).toHaveLength(0);

    // Editing the limit while off keeps the rule off.
    const edited = await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, amount: 120 }, "board", rule.policyId);
    expect(edited).toMatchObject({ isActive: false, configuredAmount: 120 });

    const on = await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, isActive: true }, "board", rule.policyId);
    expect(on).toMatchObject({ policyId: rule.policyId, isActive: true, amount: 120, configuredAmount: 120, status: "hard_stop" });
    expect(await budgets.getConnectionBlock(f.companyId, f.engineerId, null, f.minimaxId)).not.toBeNull();
    expect(await db.select().from(budgetPolicies)).toHaveLength(1);
  });

  it("releases a scope paused by its budget while the budget is off", async () => {
    const f = await fixture();
    const budgets = budgetService(db);
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Budgeted", status: "in_progress" });
    const paused = async () => (await db.select().from(projects).where(eq(projects.id, projectId)))[0].pauseReason;
    await budgets.upsertPolicy(f.companyId, { scopeType: "project", scopeId: projectId, amount: 100 }, "board");
    await costService(db).createEvent(f.companyId, { agentId: f.reviewerId, projectId, provider: "anthropic", biller: "anthropic",
      billingType: "metered_api", costStatus: "reported", model: "test-model", costCents: "150", occurredAt: new Date() });
    expect(await paused()).toBe("budget");
    const off = await budgets.upsertPolicy(f.companyId, { scopeType: "project", scopeId: projectId, isActive: false }, "board");
    expect(off).toMatchObject({ isActive: false, configuredAmount: 100, paused: false });
    expect(await paused()).toBeNull();
    await budgets.upsertPolicy(f.companyId, { scopeType: "project", scopeId: projectId, isActive: true }, "board");
    expect(await paused()).toBe("budget");
  });
});
