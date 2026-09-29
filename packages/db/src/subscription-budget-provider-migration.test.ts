import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("subscription provider migration", () => {
  it("preserves shared limits for both providers and leaves money budgets unchanged", async () => {
    const database = await startEmbeddedPostgresTestDatabase("provider-budget-migration-");
    const sql = postgres(database.connectionString, { max: 1 });
    try {
      // Replay on an isolated pre-migration table, without touching the freshly
      // migrated public schema or relying on hand-copied migration statements.
      await sql`CREATE SCHEMA provider_budget_test`;
      await sql`SET search_path TO provider_budget_test, public`;
      await sql`CREATE TABLE provider_budget_test.budget_policies (LIKE public.budget_policies INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`;
      await sql`ALTER TABLE provider_budget_test.budget_policies DROP COLUMN provider`;
      await sql`CREATE UNIQUE INDEX budget_policies_company_scope_metric_unique_idx ON provider_budget_test.budget_policies (company_id, scope_type, scope_id, metric, window_kind)`;
      await sql`INSERT INTO provider_budget_test.budget_policies (id, company_id, scope_type, scope_id, metric, window_kind, amount, progressive, is_active) VALUES
        ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'company', '22222222-2222-4222-8222-222222222222', 'subscription_percent', 'provider_week', 100, true, true),
        ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'company', '22222222-2222-4222-8222-222222222222', 'subscription_percent', 'provider_session', 0, false, false),
        ('44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', 'company', '22222222-2222-4222-8222-222222222222', 'billed_cents', 'calendar_month_utc', 5000, false, true)`;
      const migration = await readFile(new URL("./migrations/0290_flippant_cable.sql", import.meta.url), "utf8");
      await sql.begin(async (tx) => {
        for (const statement of migration.split("--> statement-breakpoint")) await tx.unsafe(statement);
      });
      const rows = await sql`SELECT id, provider, metric, window_kind, amount, progressive, is_active FROM provider_budget_test.budget_policies`;
      expect(rows).toHaveLength(5);
      expect(rows.find((r) => r.id === "11111111-1111-4111-8111-111111111111")).toMatchObject({ provider: "openai", amount: 100, progressive: true, is_active: true });
      expect(rows.find((r) => r.provider === "anthropic" && r.window_kind === "provider_week")).toMatchObject({ amount: 100, progressive: true, is_active: true });
      expect(rows.filter((r) => r.window_kind === "provider_session").every((r) => r.amount === 0 && !r.is_active)).toBe(true);
      expect(rows.find((r) => r.metric === "billed_cents")).toMatchObject({ id: "44444444-4444-4444-8444-444444444444", provider: "", amount: 5000 });
    } finally { await sql.end(); await database.cleanup(); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
