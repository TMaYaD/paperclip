DROP INDEX "budget_policies_company_scope_metric_unique_idx";--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN "connection_filter" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "ai_connection_id" uuid;--> statement-breakpoint
CREATE INDEX "cost_events_company_ai_connection_occurred_idx" ON "cost_events" USING btree ("company_id","ai_connection_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_policies_company_scope_metric_unique_idx" ON "budget_policies" USING btree ("company_id","scope_type","scope_id","metric","window_kind","provider","connection_filter","progressive");--> statement-breakpoint
-- Attribute existing run usage to the AI Connection recorded on its run.
UPDATE "cost_events" AS ce SET "ai_connection_id" = (hr."context_snapshot"->'aiConnection'->>'connectionId')::uuid
FROM "heartbeat_runs" AS hr
WHERE ce."heartbeat_run_id" = hr."id" AND ce."company_id" = hr."company_id" AND ce."ai_connection_id" IS NULL
  AND hr."context_snapshot"->'aiConnection'->>'connectionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';--> statement-breakpoint
-- Service charges name their connection on the invocation row.
UPDATE "cost_events" AS ce SET "ai_connection_id" = di."connection_id"
FROM "decision_invocations" AS di
WHERE ce."usage_kind" = 'decision' AND ce."ai_connection_id" IS NULL AND ce."company_id" = di."company_id"
  AND ce."idempotency_key" = 'decision:' || di."id"::text;--> statement-breakpoint
UPDATE "cost_events" AS ce SET "ai_connection_id" = pi."connection_id"
FROM "prompt_injection_invocations" AS pi
WHERE ce."usage_kind" = 'prompt_injection' AND ce."ai_connection_id" IS NULL AND ce."company_id" = pi."company_id"
  AND ce."idempotency_key" = 'prompt-injection:' || pi."id"::text;--> statement-breakpoint
UPDATE "cost_events" AS ce SET "ai_connection_id" = fr."connection_id"
FROM "fast_response_requests" AS fr
WHERE ce."usage_kind" = 'fast_response' AND ce."ai_connection_id" IS NULL AND ce."company_id" = fr."company_id"
  AND fr."connection_id" IS NOT NULL AND ce."idempotency_key" = 'fast-response:' || fr."id"::text;
--> statement-breakpoint
-- Subscription rules belong to one connection. A provider rule read the host
-- login's usage, so it becomes a rule on that provider's local credentials.
UPDATE "budget_policies" SET "connection_filter" = 'local:' || "provider"
WHERE "metric" = 'subscription_percent' AND "connection_filter" = '' AND "provider" <> '';
