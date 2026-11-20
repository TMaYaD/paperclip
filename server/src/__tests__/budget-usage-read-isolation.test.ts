import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { budgetPolicies, companies, createDb, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import type { AiConnectionUsage } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resetAccountUsageObservations } from "../services/account-usage-observations.js";

// Reading a real connection credential records its use with an UPDATE. The
// fake does the same through whatever database it is given, so a read that
// runs inside the overview's read-only snapshot fails exactly as production did.
const usageReads = vi.hoisted(() => ({ databases: [] as unknown[] }));
vi.mock("../services/ai-connections.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/ai-connections.js")>();
  return {
    ...original,
    aiConnectionService: (db: Db) => ({
      ...original.aiConnectionService(db),
      budgetUsage: async (companyId: string, connectionId: string): Promise<AiConnectionUsage> => {
        usageReads.databases.push(db);
        await db.execute(sql`update tool_connections set updated_at = now() where id = ${connectionId}`);
        return { connectionId, grantId: "grant", provider: "anthropic", method: "api_key", status: "ok", checkedAt: new Date().toISOString(),
          source: "test", planType: null, overage: null, limits: [{ id: "w", label: "Weekly usage", scope: null, windowDurationSeconds: 604800,
            resetsAt: null, usedPercent: 83, remainingPercent: 17, used: null, limit: null, remaining: null, unit: null, limitReached: false, allowed: null }] };
      },
    }),
  };
});

const { budgetService } = await import("../services/budgets.js");

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("connection usage reads in budget summaries", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("budget-usage-read-isolation-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    resetAccountUsageObservations();
    usageReads.databases.length = 0;
    await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      await tx.execute(sql`TRUNCATE companies CASCADE`);
    });
  });
  afterAll(async () => { await database?.cleanup(); });

  it("reads a managed connection's usage outside the overview's read-only snapshot", async () => {
    const companyId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Usage", issuePrefix: `U${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: applicationId, type: "rest_api" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "My api.minimax.io", uid: connectionId,
      connectionPurpose: "ai", transport: "runtime_auth", status: "active", enabled: true,
      config: { ai: { provider: "anthropic", method: "api_key", routing: { kind: "gateway", protocol: "messages", baseUrl: "https://api.minimax.io/anthropic", auth: "bearer", models: [] } } } });
    await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId, metric: "subscription_percent",
      windowKind: "provider_week", provider: "anthropic", connectionFilter: connectionId, amount: 90 });

    const overview = await budgetService(db).overview(companyId);
    expect(overview.policies[0]).toMatchObject({ connectionName: "My api.minimax.io", usageUnavailable: false, observedAmount: 83 });
    expect(usageReads.databases).toEqual([db]);
  });
});
