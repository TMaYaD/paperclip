import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiQuotaObservations, companies, connectionGrants, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { asc, eq } from "drizzle-orm";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { RETENTION_MS, UNCHANGED_KEEP_MS, recordQuotaObservation, resetQuotaObservationHistory } from "../services/quota-observation-history.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

const result = (weekly: number, overrides: Partial<ProviderQuotaResult> = {}): ProviderQuotaResult => ({
  provider: "anthropic",
  ok: true,
  source: "managed-connection",
  capturedAt: "2026-11-26T10:00:00.000Z",
  windows: [
    { key: "seven_day", label: "Current week (all models)", usedPercent: weekly, resetsAt: "2026-11-29T10:00:00.073196+00:00" },
    { key: "five_hour", label: "Current session", usedPercent: 5, resetsAt: "2026-11-26T14:30:00Z" },
    { key: "extra_usage", label: "Extra usage", usedPercent: null, resetsAt: null, valueLabel: "Not enabled" },
  ],
  ...overrides,
});

suite("quota observation history", () => {
  let db: ReturnType<typeof createDb>;
  let temporaryDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let companyId: string, connectionId: string, grantId: string;

  beforeAll(async () => {
    temporaryDb = await startEmbeddedPostgresTestDatabase("quota-observation-history-");
    db = createDb(temporaryDb.connectionString);
  }, 60_000);
  afterAll(async () => { await temporaryDb?.cleanup(); });

  beforeEach(async () => {
    resetQuotaObservationHistory();
    companyId = randomUUID(); connectionId = randomUUID(); grantId = randomUUID();
    const applicationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Quota fixture", issuePrefix: `Q${companyId.slice(0, 6)}` });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Anthropic", type: "rest_api" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "My Claude", uid: `quota-${connectionId}`, connectionPurpose: "ai", transport: "runtime_auth" });
    await db.insert(connectionGrants).values({ id: grantId, companyId, connectionId, kind: "user", subjectUserId: "owner" });
  });

  const rows = () => db.select().from(aiQuotaObservations)
    .where(eq(aiQuotaObservations.connectionId, connectionId))
    .orderBy(asc(aiQuotaObservations.createdAt), asc(aiQuotaObservations.windowKey));

  it("keeps each reported window and skips windows without a percentage", async () => {
    const now = Date.parse("2026-11-26T10:00:00Z");
    expect(await recordQuotaObservation(db, { companyId, connectionId, grantId, result: result(35), now })).toBe(2);
    const kept = await rows();
    expect(kept.map(row => [row.windowKey, row.usedPercent, row.provider, row.grantId])).toEqual([
      ["five_hour", 5, "anthropic", grantId],
      ["seven_day", 35, "anthropic", grantId],
    ]);
    const weekly = kept.find(row => row.windowKey === "seven_day")!;
    expect(weekly.windowLabel).toBe("Current week (all models)");
    expect(weekly.resetsAt?.toISOString()).toBe("2026-11-29T10:00:00.073Z");
    expect(weekly.observedAt.toISOString()).toBe("2026-11-26T10:00:00.000Z");
    expect(weekly.companyId).toBe(companyId);
  });

  it("keeps a changed reading at once and an unchanged one only after the keep interval", async () => {
    const now = Date.parse("2026-11-26T10:00:00Z");
    await recordQuotaObservation(db, { companyId, connectionId, grantId, result: result(35), now });
    expect(await recordQuotaObservation(db, { companyId, connectionId, grantId, result: result(35), now: now + 60_000 })).toBe(0);
    expect(await recordQuotaObservation(db, { companyId, connectionId, grantId, result: result(36), now: now + 120_000 })).toBe(1);
    expect(await recordQuotaObservation(db, { companyId, connectionId, grantId, result: result(36), now: now + 120_000 + UNCHANGED_KEEP_MS })).toBe(2);
    const weekly = (await rows()).filter(row => row.windowKey === "seven_day").map(row => row.usedPercent);
    expect(weekly).toEqual([35, 36, 36]);
  });

  it("ignores failed and stale reads", async () => {
    const now = Date.now();
    expect(await recordQuotaObservation(db, { companyId, connectionId, grantId, result: result(35, { ok: false }), now })).toBe(0);
    expect(await recordQuotaObservation(db, { companyId, connectionId, grantId, result: result(35, { stale: true }), now })).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("deletes the connection's readings older than the retention period while writing", async () => {
    const now = Date.parse("2026-11-26T10:00:00Z");
    await db.insert(aiQuotaObservations).values({ companyId, connectionId, grantId, provider: "anthropic", windowKey: "seven_day",
      usedPercent: 10, observedAt: new Date(now - RETENTION_MS - 60_000) });
    await recordQuotaObservation(db, { companyId, connectionId, grantId, result: result(35), now });
    expect((await rows()).map(row => row.usedPercent).sort((a, b) => a - b)).toEqual([5, 35]);
  });

  it("never fails the quota read when the write fails", async () => {
    const missingConnection = randomUUID();
    await expect(recordQuotaObservation(db, { companyId, connectionId: missingConnection, grantId: null, result: result(35) })).resolves.toBe(0);
    expect(await recordQuotaObservation(db, { companyId, connectionId, grantId, result: result(35) })).toBe(2);
  });
});
