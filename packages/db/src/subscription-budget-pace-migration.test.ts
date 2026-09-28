import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("subscription pace migration", () => {
  it("preserves legacy ceilings, pace, inactive settings and money budgets", async () => {
    const database = await startEmbeddedPostgresTestDatabase("pace-budget-migration-");
    const sql = postgres(database.connectionString, { max: 1 });
    try {
      await sql`CREATE SCHEMA pace_budget_test`;
      await sql`SET search_path TO pace_budget_test, public`;
      await sql`CREATE TABLE pace_budget_test.budget_policies (LIKE public.budget_policies INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`;
      await sql`ALTER TABLE pace_budget_test.budget_policies DROP COLUMN pace_percent`;
      await sql`CREATE UNIQUE INDEX budget_policies_company_scope_metric_unique_idx ON pace_budget_test.budget_policies (company_id, scope_type, scope_id, metric, window_kind, provider)`;
      const company = "22222222-2222-4222-8222-222222222222";
      for (const [provider, window, amount, progressive, active, metric] of [
        ["openai", "provider_week", 70, true, true, "subscription_percent"],
        ["anthropic", "provider_week", 100, true, true, "subscription_percent"],
        ["openai", "provider_session", 40, true, false, "subscription_percent"],
        ["anthropic", "provider_session", 0, true, false, "subscription_percent"],
        ["", "calendar_month_utc", 5000, false, true, "billed_cents"],
      ] as const) {
        await sql`INSERT INTO pace_budget_test.budget_policies (company_id, scope_type, scope_id, metric, provider, window_kind, amount, progressive, is_active) VALUES (${company}, 'company', ${company}, ${metric}, ${provider}, ${window}, ${amount}, ${progressive}, ${active})`;
      }
      const before = await sql`SELECT * FROM pace_budget_test.budget_policies`;
      const migration = await readFile(new URL("./migrations/0280_daffy_talisman.sql", import.meta.url), "utf8");
      await sql.begin(async (tx) => { for (const statement of migration.split("--> statement-breakpoint")) await tx.unsafe(statement); });
      const rows = await sql`SELECT * FROM pace_budget_test.budget_policies`;
      expect(rows).toHaveLength(7);
      for (const original of before) {
        const pace = rows.find((r) => r.id === original.id)!;
        expect(pace.is_active).toBe(original.is_active);
        if (!original.progressive) { expect(pace.amount).toBe(original.amount); expect(pace.pace_percent).toBeNull(); continue; }
        const units = original.window_kind === "provider_week" ? 7 : 5;
        expect(pace.pace_percent).toBeCloseTo(original.amount / units, 12);
        expect(pace.amount).toBe(original.amount > 0 ? 100 : 0);
        const cap = rows.find((r) => !r.progressive && r.provider === original.provider && r.window_kind === original.window_kind);
        if (original.amount > 0 && original.amount < 100) expect(cap).toMatchObject({ amount: original.amount, is_active: original.is_active });
        else expect(cap).toBeUndefined();
        // Every point in the old release curve is preserved by the conjunction.
        for (const elapsed of [0, 0.1, 0.5, 0.99, 1]) {
          expect(Math.min(pace.pace_percent * units * elapsed, cap?.amount ?? pace.amount)).toBeCloseTo(original.amount * elapsed, 10);
        }
      }
      await expect(sql`INSERT INTO pace_budget_test.budget_policies (company_id, scope_type, scope_id, metric, provider, window_kind, amount, progressive) VALUES (${company}, 'company', ${company}, 'subscription_percent', 'openai', 'provider_week', 80, false)`).rejects.toMatchObject({ code: "23505" });
    } finally { await sql.end(); await database.cleanup(); }
  }, 30000);
});
