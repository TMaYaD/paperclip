DROP INDEX "budget_policies_company_scope_metric_unique_idx";--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN "provider" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_policies_company_scope_metric_unique_idx" ON "budget_policies" USING btree ("company_id","scope_type","scope_id","metric","window_kind","provider");--> statement-breakpoint
-- Existing subscription limits applied independently to both providers. Split
-- them without changing the limit or release mode; retain the original ID for
-- OpenAI and create an equivalent Anthropic rule. Money budgets stay unchanged.
UPDATE "budget_policies" SET "provider" = 'openai'
WHERE "metric" = 'subscription_percent' AND "provider" = '';
--> statement-breakpoint
INSERT INTO "budget_policies" (
  "company_id", "scope_type", "scope_id", "metric", "provider", "window_kind",
  "amount", "progressive", "warn_percent", "hard_stop_enabled", "notify_enabled",
  "is_active", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at"
)
SELECT "company_id", "scope_type", "scope_id", "metric", 'anthropic', "window_kind",
  "amount", "progressive", "warn_percent", "hard_stop_enabled", "notify_enabled",
  "is_active", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at"
FROM "budget_policies" WHERE "metric" = 'subscription_percent' AND "provider" = 'openai'
ON CONFLICT ("company_id", "scope_type", "scope_id", "metric", "window_kind", "provider") DO NOTHING;
