DROP INDEX "budget_policies_company_scope_metric_unique_idx";--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN "pace_percent" double precision;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_policies_company_scope_metric_unique_idx" ON "budget_policies" USING btree ("company_id","scope_type","scope_id","metric","window_kind","provider","progressive");--> statement-breakpoint
-- Preserve the old progressive ceiling as a separate cap before converting
-- the original rule to an explicit pace. Preserve IDs, authors and active state.
INSERT INTO "budget_policies" (
 "company_id", "scope_type", "scope_id", "metric", "provider", "window_kind",
 "amount", "progressive", "warn_percent", "hard_stop_enabled", "notify_enabled",
 "is_active", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at"
)
SELECT "company_id", "scope_type", "scope_id", "metric", "provider", "window_kind",
 "amount", false, "warn_percent", "hard_stop_enabled", "notify_enabled",
 "is_active", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at"
FROM "budget_policies"
WHERE "metric" = 'subscription_percent' AND "progressive" AND "amount" > 0 AND "amount" < 100;
--> statement-breakpoint
UPDATE "budget_policies"
SET "pace_percent" = "amount"::double precision / CASE WHEN "window_kind" = 'provider_week' THEN 7 ELSE 5 END,
    "amount" = CASE WHEN "amount" > 0 THEN 100 ELSE 0 END
WHERE "metric" = 'subscription_percent' AND "progressive";
