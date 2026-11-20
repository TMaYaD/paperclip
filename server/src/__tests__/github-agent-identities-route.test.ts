import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("GET github-agent-identities", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-identities-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  function appFor(actor: Record<string, unknown>) {
    const app = express();
    app.use((req, _res, next) => { req.actor = actor as never; next(); });
    app.use("/api", toolAccessRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", adapterType: "codex_local" });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "member", status: "active", membershipRole: "member",
    });
    const applicationId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: applicationId, type: "mcp_http" });
    async function connection(dedicated: boolean, login: string) {
      const connectionId = randomUUID(), secretId = randomUUID(), definitionId = randomUUID();
      await db.insert(toolConnections).values({
        id: connectionId, companyId, applicationId, name: `${login} connection`, uid: connectionId,
        transport: "mcp_remote", status: "active", enabled: true,
        credentialPolicy: dedicated ? "per_agent" : "per_user", config: { sourceTemplateKey: "github" },
      });
      await db.insert(toolConnectionInstalls).values({ companyId, connectionId, targetType: "agent", targetId: agentId });
      if (!dedicated) await db.insert(userSecretDefinitions).values({ id: definitionId, companyId, key: definitionId, name: "GitHub" });
      await db.insert(companySecrets).values({
        id: secretId, companyId, key: secretId, name: secretId, scope: dedicated ? "company" : "user",
        ownerUserId: dedicated ? null : "member", userSecretDefinitionId: dedicated ? null : definitionId,
      });
      await db.insert(connectionGrants).values({
        companyId, connectionId, kind: dedicated ? "agent" : "user", status: "active",
        subjectUserId: dedicated ? null : "member", subjectAgentId: dedicated ? agentId : null,
        credentialSecretRefs: [{ secretId, configPath: "oauth.access_token", versionSelector: "latest" }],
        providerTenant: { github: { userId: login, login, installationCount: 1, repositoryCount: 1,
          repositorySelection: "selected", installationIds: ["1"], installationOwnerLogins: [login] } },
      });
      return connectionId;
    }
    return { companyId, agentId, personal: await connection(false, "personal-a"), dedicated: await connection(true, "dedicated-b") };
  }

  const member = (companyId: string) => ({
    type: "board", userId: "member", source: "session", isInstanceAdmin: false,
    companyIds: [companyId], memberships: [{ companyId, membershipRole: "member", status: "active" }],
  });
  const manager = { type: "board", userId: "manager", source: "local_implicit", isInstanceAdmin: true };

  it("hides other connections' account labels and dedicated subjects from ordinary members but not managers", async () => {
    const seeded = await seed();
    const path = `/api/tool-connections/${seeded.personal}/github-agent-identities`;
    const asMember = await request(appFor(member(seeded.companyId))).get(path);
    expect(asMember.status).toBe(200);
    expect(asMember.body.agents[0]).toMatchObject({
      agentId: seeded.agentId, state: "selected_elsewhere", selectedConnectionId: null,
      selectedConnectionName: null, selectedAccountLogin: null,
    });
    expect(asMember.body.dedicatedAgentIds).toEqual([]);
    expect(JSON.stringify(asMember.body)).not.toContain("dedicated-b");
    const asManager = await request(appFor(manager)).get(path);
    expect(asManager.body.agents[0]).toMatchObject({
      state: "selected_elsewhere", selectedConnectionId: seeded.dedicated, selectedAccountLogin: "dedicated-b",
    });
    const onDedicated = await request(appFor(manager)).get(`/api/tool-connections/${seeded.dedicated}/github-agent-identities`);
    expect(onDedicated.body.dedicatedAgentIds).toEqual([seeded.agentId]);
    for (const body of [asMember.body, asManager.body, onDedicated.body]) {
      expect(JSON.stringify(body)).not.toMatch(/secretId|credentialSecretRefs|oauth\.access_token/);
    }
  });

  it("denies other companies, agents and non-GitHub connections", async () => {
    const seeded = await seed();
    const other = await seed();
    const path = `/api/tool-connections/${seeded.personal}/github-agent-identities`;
    expect((await request(appFor(member(other.companyId))).get(path)).status).toBeGreaterThanOrEqual(403);
    expect((await request(appFor({ type: "agent", agentId: seeded.agentId, companyId: seeded.companyId })).get(path)).status).toBe(403);
    const plain = randomUUID();
    const [app] = await db.select({ id: toolApplications.id }).from(toolApplications).limit(1);
    await db.insert(toolConnections).values({
      id: plain, companyId: seeded.companyId, applicationId: app!.id, name: "plain", uid: plain,
      transport: "mcp_remote", status: "active", enabled: true, config: {},
    });
    expect((await request(appFor(manager)).get(`/api/tool-connections/${plain}/github-agent-identities`)).status).toBe(400);
  });
});
