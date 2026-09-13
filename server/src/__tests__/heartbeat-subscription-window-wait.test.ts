import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  SUBSCRIPTION_WINDOW_SKIPPED_ERROR_CODE,
  SUBSCRIPTION_WINDOW_WAIT_RETRY_REASON,
  subscriptionWindowGateService,
} from "../services/subscription-window-gate.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Subscription window wait test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat subscription window tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function cleanupFixture(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
          "issue_comments",
          "issue_relations",
          "issues",
          "heartbeat_run_events",
          "cost_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "budget_policies",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `));
      return;
    } catch (error) {
      const isLateCommentRace =
        error instanceof Error && error.message.includes("issue_comments_issue_id_issues_id_fk");
      if (!isLateCommentRace || attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

const SATURATED_SESSION_RESET = "2099-01-01T00:00:00.000Z";

function quotaResults(input: { fiveHourUsedPercent: number | null; sevenDayUsedPercent?: number | null }): ProviderQuotaResult[] {
  return [
    {
      provider: "openai",
      ok: true,
      windows: [
        {
          key: "five_hour",
          label: "5h limit",
          usedPercent: input.fiveHourUsedPercent,
          resetsAt: SATURATED_SESSION_RESET,
          valueLabel: null,
          detail: null,
        },
        {
          key: "seven_day",
          label: "Weekly limit",
          usedPercent: input.sevenDayUsedPercent ?? 10,
          resetsAt: null,
          valueLabel: null,
          detail: null,
        },
      ],
    },
  ];
}

describeEmbeddedPostgres("heartbeat subscription window wait", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let currentQuota: ProviderQuotaResult[] = quotaResults({ fiveHourUsedPercent: 0 });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-subscription-window-");
    db = createDb(tempDb.connectionString);
    const gate = subscriptionWindowGateService(db, {
      readQuotaSnapshot: async () => ({ results: currentQuota, fetchedAt: new Date() }),
    });
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
      subscriptionWindowGate: gate,
    });
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    currentQuota = quotaResults({ fiveHourUsedPercent: 0 });
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await waitForCondition(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return !runs.some((run) => run.status === "queued" || run.status === "running");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cleanupFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentAndIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Subscription window wait",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  async function seedSessionPolicy(companyId: string, amount: number) {
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "subscription_percent",
      windowKind: "provider_session",
      amount,
    });
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    invocationSource: "assignment" | "timer";
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.invocationSource,
      triggerDetail: "system",
      reason: input.invocationSource === "timer" ? "heartbeat_timer" : "issue_assigned",
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource,
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: input.invocationSource === "timer" ? "heartbeat_timer" : "issue_assigned",
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  async function readRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  it("defers an assignment run to the window reset instead of cancelling it", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentAndIssue();
    await seedSessionPolicy(companyId, 80);
    currentQuota = quotaResults({ fiveHourUsedPercent: 85 });
    const { runId, wakeupRequestId } = await seedQueuedRun({ companyId, agentId, issueId, invocationSource: "assignment" });

    await heartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => (await readRun(runId))?.status === "scheduled_retry")).toBe(true);
    const run = await readRun(runId);
    expect(run?.scheduledRetryReason).toBe(SUBSCRIPTION_WINDOW_WAIT_RETRY_REASON);
    expect(run?.scheduledRetryAttempt).toBe(1);
    expect(run?.scheduledRetryAt?.toISOString()).toBe("2099-01-01T00:00:30.000Z");
    expect(run?.errorCode).toBeNull();
    expect((run?.resultJson as Record<string, unknown>)?.subscriptionWindowWait).toMatchObject({
      quotaKey: "five_hour",
      usedPercent: 85,
      limitPercent: 80,
      provider: "openai",
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    // Nothing on this path asks a human for help: the issue keeps its status,
    // the wake stays queued, and no comment is written.
    const issue = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("in_progress");
    const wake = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)).then((rows) => rows[0]);
    expect(wake?.status).toBe("queued");
    const comments = await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
    const events = await db
      .select({ message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(events.some((event) => event.message?.startsWith("Deferred until the provider subscription window resets"))).toBe(true);
  });

  it("promotes the deferred run and executes it once the window has reset", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentAndIssue();
    await seedSessionPolicy(companyId, 80);
    currentQuota = quotaResults({ fiveHourUsedPercent: 85 });
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId, invocationSource: "assignment" });

    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => (await readRun(runId))?.status === "scheduled_retry")).toBe(true);

    // Simulate the reset: usage dropped and the scheduled time has passed.
    currentQuota = quotaResults({ fiveHourUsedPercent: 5 });
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, runId));

    const promotion = await heartbeat.promoteDueScheduledRetries();
    expect(promotion.runIds).toContain(runId);
    await heartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => (await readRun(runId))?.status === "succeeded")).toBe(true);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("re-defers a promoted run when the window is still saturated, counting attempts", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentAndIssue();
    await seedSessionPolicy(companyId, 80);
    currentQuota = quotaResults({ fiveHourUsedPercent: 99 });
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId, invocationSource: "assignment" });

    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => (await readRun(runId))?.status === "scheduled_retry")).toBe(true);

    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, runId));
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRuns();

    expect(
      await waitForCondition(async () => {
        const run = await readRun(runId);
        return run?.status === "scheduled_retry" && run.scheduledRetryAttempt === 2;
      }),
    ).toBe(true);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("skips a timer heartbeat quietly while the window is saturated", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentAndIssue();
    await seedSessionPolicy(companyId, 80);
    currentQuota = quotaResults({ fiveHourUsedPercent: 100 });
    const { runId, wakeupRequestId } = await seedQueuedRun({ companyId, agentId, issueId, invocationSource: "timer" });

    await heartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => (await readRun(runId))?.status === "cancelled")).toBe(true);
    const run = await readRun(runId);
    expect(run?.errorCode).toBe(SUBSCRIPTION_WINDOW_SKIPPED_ERROR_CODE);
    const wake = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)).then((rows) => rows[0]);
    expect(wake?.status).toBe("skipped");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const comments = await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("runs normally when no subscription policy exists, even with a saturated window", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentAndIssue();
    currentQuota = quotaResults({ fiveHourUsedPercent: 100 });
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId, invocationSource: "assignment" });

    await heartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => (await readRun(runId))?.status === "succeeded")).toBe(true);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("runs normally when the quota snapshot is unavailable (fail open)", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentAndIssue();
    await seedSessionPolicy(companyId, 80);
    currentQuota = [{ provider: "openai", ok: false, error: "usage endpoint down", windows: [] }];
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId, invocationSource: "assignment" });

    await heartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => (await readRun(runId))?.status === "succeeded")).toBe(true);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });
});
