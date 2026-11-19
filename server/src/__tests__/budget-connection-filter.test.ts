import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetIncidents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { BUDGET_CONNECTION_FILTER_UNMANAGED } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { budgetService, computeObservedSpend } from "../services/budgets.js";
import { costService } from "../services/costs.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("connection-filtered budgets", () => {
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

  /** Architect runs on host credentials; Engineer runs on a MiniMax connection. */
  async function fixture() {
    const companyId = randomUUID(), architectId = randomUUID(), engineerId = randomUUID();
    const applicationId = randomUUID(), minimaxId = randomUUID(), grantId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Connections", issuePrefix: `C${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values([
      { id: architectId, companyId, name: "Architect", role: "engineer", status: "idle", adapterType: "claude_local" },
      { id: engineerId, companyId, name: "Engineer", role: "engineer", status: "idle", adapterType: "claude_local" },
    ]);
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: applicationId, type: "custom" });
    await db.insert(toolConnections).values({ id: minimaxId, companyId, applicationId, name: "my api.minimax.io", uid: minimaxId,
      connectionPurpose: "ai", transport: "runtime_auth", status: "active", enabled: true, config: { ai: { provider: "anthropic", method: "api_key" } } });
    const run = async (agentId: string, connectionId: string | null) => {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({ id, companyId, agentId, invocationSource: "on_demand", status: "succeeded",
        contextSnapshot: connectionId ? { aiConnection: { connectionId, grantId, provider: "anthropic", method: "api_key", mode: "shared", responsibleUserId: null } } : {} });
      return id;
    };
    const charge = async (agentId: string, heartbeatRunId: string, costCents: string, biller = "anthropic") =>
      costService(db).createEvent(companyId, { agentId, heartbeatRunId, provider: "anthropic", biller, billingType: "metered_api",
        costStatus: "reported", model: "claude-test", inputTokens: 10, outputTokens: 5, costCents, occurredAt: new Date() });
    return { companyId, architectId, engineerId, minimaxId, run, charge };
  }

  it("attributes run usage to the run's connection and reports spend per connection", async () => {
    const f = await fixture();
    const architect = await f.charge(f.architectId, await f.run(f.architectId, null), "300");
    const engineer = await f.charge(f.engineerId, await f.run(f.engineerId, f.minimaxId), "120", "minimax");
    expect(architect.aiConnectionId).toBeNull();
    expect(engineer.aiConnectionId).toBe(f.minimaxId);

    const rows = await costService(db).byConnection(f.companyId);
    expect(rows.map((row) => [row.connectionId, row.connectionName, row.costCentsExact, row.agentCount])).toEqual([
      [null, null, "300.0000000", 1],
      [f.minimaxId, "my api.minimax.io", "120.0000000", 1],
    ]);
  });

  it("lists unused connections so they can be budgeted before first use", async () => {
    const f = await fixture();
    const rows = await costService(db).byConnection(f.companyId);
    expect(rows.find((row) => row.connectionId === f.minimaxId)).toMatchObject({ costCents: 0, eventCount: 0, connectionExists: true, provider: "anthropic" });
  });

  it("counts only the filtered connection's spend and leaves the scope's base budget alone", async () => {
    const f = await fixture();
    await db.update(companies).set({ budgetMonthlyCents: 5000 }).where(eq(companies.id, f.companyId));
    await f.charge(f.architectId, await f.run(f.architectId, null), "300");
    await f.charge(f.engineerId, await f.run(f.engineerId, f.minimaxId), "120");
    const budgets = budgetService(db);
    const minimax = await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, connectionFilter: f.minimaxId, amount: 1000 }, "board");
    const unmanaged = await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, connectionFilter: BUDGET_CONNECTION_FILTER_UNMANAGED, amount: 1000 }, "board");
    expect(minimax).toMatchObject({ connectionFilter: f.minimaxId, connectionName: "my api.minimax.io", observedAmountExact: "120.0000000", status: "ok" });
    expect(unmanaged).toMatchObject({ connectionFilter: "unmanaged", connectionName: "Existing authentication", observedAmountExact: "300.0000000" });
    const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
    expect(company.budgetMonthlyCents).toBe(5000);
    expect((await db.select().from(budgetPolicies)).length).toBe(2);

    // An edit by ID that omits the filter keeps the rule on its connection.
    const edited = await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, amount: 2000 }, "board", minimax.policyId);
    expect(edited).toMatchObject({ policyId: minimax.policyId, connectionFilter: f.minimaxId, amount: 2000 });
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].budgetMonthlyCents).toBe(5000);
  });

  it("hard-stops the scope when the connection's spend reaches its budget, and releases it on delete", async () => {
    const f = await fixture();
    const budgets = budgetService(db);
    const rule = await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, connectionFilter: f.minimaxId, amount: 100 }, "board");
    await f.charge(f.architectId, await f.run(f.architectId, null), "500");
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].status).toBe("active");

    await f.charge(f.engineerId, await f.run(f.engineerId, f.minimaxId), "150");
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0]).toMatchObject({ status: "paused", pauseReason: "budget" });
    const overview = await budgets.overview(f.companyId);
    expect(overview.activeIncidents[0]).toMatchObject({ policyId: rule.policyId, connectionFilter: f.minimaxId, connectionName: "my api.minimax.io" });

    await budgets.deletePolicy(f.companyId, rule.policyId, "board");
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0]).toMatchObject({ status: "active", pauseReason: null });
    // The incident keeps its policy, so the fired rule is retired, not deleted.
    const [retired] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, rule.policyId));
    expect(retired).toMatchObject({ amount: 0, isActive: false });
    expect((await db.select().from(budgetIncidents))[0].status).toBe("resolved");
    expect((await budgets.overview(f.companyId)).policies).toHaveLength(0);

    // Re-adding the same rule reactivates that row.
    const again = await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, connectionFilter: f.minimaxId, amount: 10_000 }, "board");
    expect(again.policyId).toBe(rule.policyId);
    expect(again.isActive).toBe(true);
  });

  it("rejects a connection from another company and subscription rules with a connection", async () => {
    const f = await fixture();
    const other = await fixture();
    const budgets = budgetService(db);
    await expect(budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, connectionFilter: other.minimaxId, amount: 100 }, "board"))
      .rejects.toThrow(/AI connection in this company/);
    await expect(budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, metric: "subscription_percent", provider: "anthropic",
      windowKind: "provider_week", connectionFilter: f.minimaxId, amount: 50 }, "board")).rejects.toThrow(/money budgets only/);
  });

  it("matches unfinished runs on the connection recorded on the run", async () => {
    const f = await fixture();
    const [policy] = await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 1000, connectionFilter: f.minimaxId, notifyEnabled: false }).returning();
    const live = (agentId: string, connectionId: string | null, costUsd: number) => db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId, agentId,
      invocationSource: "on_demand", status: "running", costAccountingPending: true, usageJson: { costUsd },
      contextSnapshot: connectionId ? { aiConnection: { connectionId } } : {} });
    await live(f.engineerId, f.minimaxId, 0.4);
    await live(f.architectId, null, 2);
    expect((await computeObservedSpend(db, policy)).liveObservedCents).toBe("40.0000000");
    expect((await computeObservedSpend(db, { ...policy, connectionFilter: BUDGET_CONNECTION_FILTER_UNMANAGED })).liveObservedCents).toBe("200.0000000");
    expect((await computeObservedSpend(db, { ...policy, connectionFilter: "" })).liveObservedCents).toBe("240.0000000");
  });
});
